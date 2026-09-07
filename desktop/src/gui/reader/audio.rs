//! Audio decode + device output for the reader screen.
//!
//! **Decode (spike decision, task 001):** `ogg` demux + `opus` (libopus via
//! opusic-sys) decode of one segment's OGG/Opus bytes — the same crates
//! `taletrek-synth`'s `NativeOpusEncoder` used to *write* those bytes, so
//! container and codec agree by construction. The spec's preferred
//! `symphonia` was ruled out on fact: it has no released Opus decoder (no
//! `opus` feature in the 0.5/0.6 umbrella crate, no `symphonia-codec-opus`
//! on crates.io). The named fallback `audiopus` would have linked a second
//! static libopus beside opusic-sys — the in-tree pair adds zero crates.
//! **Output:** cpal; the device test is `#[ignore]`d (real hardware).

use std::io::Cursor;

use ogg::PacketReader;
use opus::Channels;

/// One segment's decoded audio: interleaved i16 PCM at `sample_rate`, the
/// libopus-native rate nearest the voice's original rate (Opus decode is
/// always whole-stream single-rate; 22050 Hz voices decode at 24 kHz).
#[derive(Debug)]
#[allow(dead_code)] // wired into the transport in task 005; tests use it today
pub(crate) struct DecodedAudio {
    pub(crate) samples: Vec<i16>,
    pub(crate) sample_rate: u32,
    pub(crate) channels: usize,
}

/// A failed OGG/Opus decode. One sentence; no ogg/opus types leak.
#[derive(Debug, thiserror::Error)]
#[error("OGG/Opus decode failed: {0}")]
#[allow(dead_code)] // wired into the transport in task 005; tests use it today
pub(crate) struct DecodeError(String);

/// Output rates libopus can decode to natively (Hz); anything else decodes
/// at the nearest entry.
const OPUS_RATES: [u32; 5] = [8_000, 12_000, 16_000, 24_000, 48_000];

/// Max samples per channel libopus emits for one packet (120 ms @ 48 kHz).
const MAX_FRAME: usize = 5_760;

/// The libopus-native output rate closest to `rate` (22050 → 24000).
fn nearest_rate(rate: u32) -> u32 {
    OPUS_RATES
        .into_iter()
        .min_by_key(|r| r.abs_diff(rate))
        .unwrap_or(48_000)
}

/// Decode a full OGG/Opus byte slice (one paragraph segment's file) to
/// interleaved PCM. The OpusHead's original input rate picks the output
/// rate; its preskip (the encoder's lookahead) is trimmed so decoded time
/// aligns with authored time.
#[allow(dead_code)] // wired into the transport in task 005; tests use it today
pub(crate) fn decode_ogg_opus(bytes: &[u8]) -> Result<DecodedAudio, DecodeError> {
    let mut rdr = PacketReader::new(Cursor::new(bytes));

    // First packet must be OpusHead (RFC 7845 §5.1): channels @9, preskip
    // (48 kHz-domain) @10..12, original input rate (advisory) @12..16.
    let head = rdr
        .read_packet()
        .map_err(|e| DecodeError(format!("first OGG packet: {e}")))?
        .ok_or_else(|| DecodeError("empty OGG stream".into()))?;
    if head.data.len() < 16 || !head.data.starts_with(b"OpusHead") {
        return Err(DecodeError("first packet is not an OpusHead".into()));
    }
    let ch_count = head.data[9] as usize;
    let channels = match ch_count {
        1 => Channels::Mono,
        2 => Channels::Stereo,
        n => return Err(DecodeError(format!("unsupported channel count {n}"))),
    };
    let preskip = u16::from_le_bytes(head.data[10..12].try_into().expect("len checked"));
    let input_rate = u32::from_le_bytes(head.data[12..16].try_into().expect("len checked"));
    let sample_rate = nearest_rate(input_rate);

    let mut dec = opus::Decoder::new(sample_rate, channels)
        .map_err(|e| DecodeError(format!("decoder create: {e}")))?;

    // preskip lives in the 48 kHz granule domain — scale it into the output
    // rate's domain, then trim that many leading samples.
    let skip = (u32::from(preskip) as u64 * u64::from(sample_rate) / 48_000) as usize;

    let mut samples: Vec<i16> = Vec::new();
    while let Some(pkt) = rdr
        .read_packet()
        .map_err(|e| DecodeError(format!("OGG read: {e}")))?
    {
        if pkt.data.starts_with(b"OpusTags") {
            continue;
        }
        let mut frame = vec![0i16; MAX_FRAME * ch_count];
        let n = dec
            .decode(&pkt.data, &mut frame, false)
            .map_err(|e| DecodeError(format!("packet decode: {e}")))?;
        samples.extend_from_slice(&frame[..n * ch_count]);
    }
    if samples.is_empty() {
        return Err(DecodeError("stream carried no audio packets".into()));
    }
    let dropped = skip.min(samples.len());
    samples.drain(..dropped);

    Ok(DecodedAudio {
        samples,
        sample_rate,
        channels: ch_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_is_typed_error() {
        assert!(decode_ogg_opus(&[0u8; 64]).is_err());
        assert!(decode_ogg_opus(&[]).is_err());
    }

    /// Round-trip against our own encode path — the effort's spike gate:
    /// prove ogg+opus decode the exact bytes `NativeOpusEncoder` produces.
    #[cfg(feature = "native-encode")]
    mod round_trip {
        use std::f64::consts::PI;

        use super::super::*;
        use taletrek_synth::{Encoder, NativeOpusEncoder};

        /// Canonical 44-byte mono 16-bit WAV around raw PCM at `rate`.
        fn wav_bytes(pcm: &[i16], rate: u32) -> Vec<u8> {
            let data_len = u32::try_from(pcm.len() * 2).unwrap();
            let mut out = Vec::with_capacity(44 + data_len as usize);
            out.extend_from_slice(b"RIFF");
            out.extend_from_slice(&(36 + data_len).to_le_bytes());
            out.extend_from_slice(b"WAVE");
            out.extend_from_slice(b"fmt ");
            out.extend_from_slice(&16u32.to_le_bytes());
            out.extend_from_slice(&1u16.to_le_bytes());
            out.extend_from_slice(&1u16.to_le_bytes());
            out.extend_from_slice(&rate.to_le_bytes());
            out.extend_from_slice(&(rate * 2).to_le_bytes());
            out.extend_from_slice(&2u16.to_le_bytes());
            out.extend_from_slice(&16u16.to_le_bytes());
            out.extend_from_slice(b"data");
            out.extend_from_slice(&data_len.to_le_bytes());
            for s in pcm {
                out.extend_from_slice(&s.to_le_bytes());
            }
            out
        }

        /// `secs` of a `freq` Hz sine at `rate`, amplitude 0.4.
        fn sine(rate: u32, secs: f64, freq: f64) -> Vec<i16> {
            let total = (f64::from(rate) * secs).round() as usize;
            (0..total)
                .map(|i| {
                    let t = f64::from(i as u32) / f64::from(rate);
                    (0.4 * (2.0 * PI * freq * t).sin() * 32767.0) as i16
                })
                .collect()
        }

        /// Estimated Hz of a mono signal via zero-crossing count.
        fn tone_hz(pcm: &[i16], rate: u32) -> f64 {
            let crossings = pcm.windows(2).filter(|w| (w[0] < 0) != (w[1] < 0)).count() as f64;
            crossings / 2.0 / (pcm.len() as f64 / f64::from(rate))
        }

        #[test]
        fn decodes_native_encoder_output() {
            let rate = 16_000;
            let src = sine(rate, 3.0, 440.0);
            let opus = NativeOpusEncoder::new()
                .encode(&wav_bytes(&src, rate))
                .expect("encode");
            let dec = decode_ogg_opus(&opus).expect("decode");

            assert_eq!(dec.channels, 1, "mono in, mono out");
            assert_eq!(
                dec.sample_rate, 16_000,
                "16 kHz is libopus-native: passthrough"
            );
            assert!(
                dec.samples.iter().map(|s| s.unsigned_abs()).max().unwrap() > 8_000,
                "decoded signal must carry the sine's amplitude"
            );
            let dur = f64::from(dec.sample_rate) * dec.channels as f64;
            let dur = dec.samples.len() as f64 / dur;
            assert!(
                (dur - 3.0).abs() < 0.05,
                "duration {dur:.3} s vs 3.0 s source (preskip trimmed, ≤20 ms pad)"
            );
            let est = tone_hz(&dec.samples, dec.sample_rate);
            assert!(
                ((est - 440.0) / 440.0).abs() < 0.05,
                "tone drifted: {est:.1} Hz vs 440"
            );
        }

        #[test]
        fn voice_rate_22050_decodes_at_nearest_native_rate() {
            let rate = 22_050;
            let src = sine(rate, 1.0, 440.0);
            let opus = NativeOpusEncoder::new()
                .encode(&wav_bytes(&src, rate))
                .expect("encode");
            let dec = decode_ogg_opus(&opus).expect("decode");

            assert_eq!(dec.sample_rate, 24_000, "22050 → nearest native rate");
            let dur = dec.samples.len() as f64 / 24_000.0;
            assert!(
                (dur - 1.0).abs() < 0.05,
                "duration {dur:.3} s vs 1.0 s source"
            );
        }
    }

    /// Real-hardware device gate: opens the default output, plays ~0.5 s of
    /// silence, asserts the device actually delivered ~0.5 s of callbacks.
    #[test]
    #[ignore = "opens the real default audio device; run manually: cargo test -p taletrek-desktop -- --ignored --nocapture"]
    fn cpal_default_output_device_plays_half_second_silence() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        fn silence_cb<T: cpal::SizedSample>(
            counter: Arc<AtomicUsize>,
            channels: usize,
        ) -> impl FnMut(&mut [T], &cpal::OutputCallbackInfo) + Send + 'static {
            move |data, _| {
                data.fill(T::EQUILIBRIUM);
                counter.fetch_add(data.len() / channels, Ordering::Relaxed);
            }
        }

        fn stream_err(e: cpal::StreamError) {
            eprintln!("[cpal] stream error: {e}");
        }

        let device = cpal::default_host()
            .default_output_device()
            .expect("a default output device exists");
        let supported = device
            .default_output_config()
            .expect("default output config");
        let config: cpal::StreamConfig = supported.clone().into();
        let channels = usize::from(config.channels);
        let half_second = (config.sample_rate.0 as usize) / 2;

        let frames_played = Arc::new(AtomicUsize::new(0));
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_output_stream(
                &config,
                silence_cb::<f32>(frames_played.clone(), channels),
                stream_err,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_output_stream(
                &config,
                silence_cb::<i16>(frames_played.clone(), channels),
                stream_err,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_output_stream(
                &config,
                silence_cb::<u16>(frames_played.clone(), channels),
                stream_err,
                None,
            ),
            other => panic!("unsupported device sample format: {other:?}"),
        }
        .expect("build output stream");

        stream.play().expect("stream plays");
        let deadline = Instant::now() + Duration::from_secs(5);
        while frames_played.load(Ordering::Relaxed) < half_second {
            assert!(
                Instant::now() < deadline,
                "device delivered <0.5 s of callbacks within 5 s"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        // Let the final buffered slice drain before the stream drops.
        std::thread::sleep(Duration::from_millis(150));
    }
}
