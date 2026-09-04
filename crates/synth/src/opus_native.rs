//! In-process Opus encoder: [`NativeOpusEncoder`] implements [`Encoder`] via
//! the `opus` crate (SpaceManiac — `opusic-sys` with its default `bundled`
//! feature) plus the pure-Rust `ogg` mux, replacing the `ffmpeg` subprocess
//! ([`crate::OpusEncoder`]) for encode. Output is byte-shape-equivalent at the
//! format level: OGG/Opus container, `.opus`, same codec identity — bundles
//! encoded by either impl are indistinguishable to the reader.
//!
//! # Feature + linking (from the T2 spike verdict)
//!
//! Only compiled under cargo feature `native-encode`. `opusic-sys`'s default
//! `bundled` feature vendors **libopus 1.6.1** and builds it with **cmake** —
//! no system libopus, no dev headers, no pkg-config, no bindgen. Build-time
//! deps: cmake + a C compiler (standard in GH Actions images; cached after
//! first build). The link is **static**: the binary grows ~0.5 MB and carries
//! no libopus `.so` dependency. `unsafe_code` stays forbidden in this crate —
//! the `opus` crate encapsulates its own FFI.
//!
//! # Mux shape (RFC 7845, verified against ffmpeg in T2)
//!
//! Page 1: `OpusHead` (input rate is advisory — all granule math is 48 kHz
//! domain; preskip = the encoder's own lookahead, already 48 k-domain) alone
//! on a forced page break, then `OpusTags`, then audio pages of 20 ms frames.
//! Opus encodes whole frames only, so a partial final frame is padded with
//! silence (< 20 ms of overshoot). The final packet **must** carry
//! `EndStream` — `ogg::PacketWriter::into_inner` silently drops an unflushed
//! page otherwise. Input rates outside libopus's 8/12/16/24/48 kHz set (e.g.
//! 22050 Hz, which real Piper voices emit) are linearly resampled to the
//! nearest supported rate before encoding.

use ogg::{PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels};

use crate::bundle::audio::AudioCodec;
use crate::encode::Encoder;
use crate::pcm::pcm_view;
use crate::synth::SynthError;

/// OGG stream serial. Fixed: each segment is its own single-stream file, so
/// per-file uniqueness (the thing serials exist for) is trivially satisfied.
const SERIAL: u32 = 0x5412_0001;

/// Vendor string stamped into the `OpusTags` packet.
const VENDOR: &str = "taletrek";

/// Input rates libopus accepts natively (Hz). Anything else gets resampled to
/// the nearest entry before encoding.
const OPUS_INPUT_RATES: [u32; 5] = [8_000, 12_000, 16_000, 24_000, 48_000];

/// 48 kHz-domain granules advanced per encoded frame (one 20 ms frame).
const GRANULES_PER_FRAME: u64 = 960;

/// Opus encoder running in-process (vendored static libopus + `ogg` mux).
///
/// Same contract and defaults as the ffmpeg-backed [`crate::OpusEncoder`]:
/// canonical mono 16-bit PCM WAV in, OGG/Opus bytes out, bitrate defaulting
/// to [`NativeOpusEncoder::DEFAULT_BITRATE`] (24 kbps).
pub struct NativeOpusEncoder {
    bitrate_bps: u32,
}

impl NativeOpusEncoder {
    /// Default speech bitrate: 24 kbps — identical to
    /// [`crate::OpusEncoder::DEFAULT_BITRATE`] so both encoders are
    /// interchangeable without changing the audio budget.
    pub const DEFAULT_BITRATE: u32 = 24_000;

    /// Create an encoder with the default bitrate.
    #[must_use]
    pub fn new() -> Self {
        Self::with_bitrate(Self::DEFAULT_BITRATE)
    }

    /// Create an encoder with a specific target bitrate (bits per second).
    #[must_use]
    pub fn with_bitrate(bitrate_bps: u32) -> Self {
        Self { bitrate_bps }
    }
}

impl Default for NativeOpusEncoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Map every failure to [`SynthError::NativeEncode`] — no `opus`/`ogg` types
/// leak past the trait boundary.
fn err(reason: impl Into<String>) -> SynthError {
    SynthError::NativeEncode {
        reason: reason.into(),
    }
}

/// OGG/Opus ID header (RFC 7845 §5.1). `input_rate` is the *original* WAV
/// rate — advisory only; every granule in the stream is 48 kHz domain.
fn opus_head(preskip: u16, channels: u16, input_rate: u32) -> Vec<u8> {
    let mut h = Vec::with_capacity(19);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(channels as u8);
    h.extend_from_slice(&preskip.to_le_bytes());
    h.extend_from_slice(&input_rate.to_le_bytes());
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain
    h.push(0); // mapping family (mono/stereo)
    h
}

/// OGG/Opus comment header (RFC 7845 §5.2): vendor string, zero comments.
fn opus_tags() -> Vec<u8> {
    let mut t = Vec::new();
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(VENDOR.len() as u32).to_le_bytes());
    t.extend_from_slice(VENDOR.as_bytes());
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

/// The libopus-native rate closest to `rate`.
fn nearest_opus_rate(rate: u32) -> u32 {
    OPUS_INPUT_RATES
        .into_iter()
        .min_by_key(|r| r.abs_diff(rate))
        .unwrap_or(48_000)
}

/// Linear-interpolation resample of interleaved i16 PCM (`from` → `to` Hz).
/// Speech-grade quality is sufficient: the only real caller is 22050 → 24000.
fn resample_linear(pcm: &[i16], from: u32, to: u32) -> Vec<i16> {
    if from == to || pcm.is_empty() {
        return pcm.to_vec();
    }
    let step = f64::from(from) / f64::from(to);
    let out_len = (pcm.len() as f64 / step).round() as usize;
    (0..out_len)
        .map(|i| {
            let src = f64::from(i as u32) * step;
            let i0 = (src.floor() as usize).min(pcm.len() - 1);
            let i1 = (i0 + 1).min(pcm.len() - 1);
            let frac = src - i0 as f64;
            let s = f64::from(pcm[i0]) * (1.0 - frac) + f64::from(pcm[i1]) * frac;
            s.round().clamp(-32768.0, 32767.0) as i16
        })
        .collect()
}

impl Encoder for NativeOpusEncoder {
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError> {
        // Parse + validate the WAV: 16-bit PCM, mono/stereo, non-empty.
        let (ch_count, rate, bits, data) = pcm_view(wav)
            .ok_or_else(|| err(format!("input is not a parsable WAV ({} bytes)", wav.len())))?;
        if bits != 16 {
            return Err(err(format!(
                "unsupported bits per sample {bits} (need 16-bit PCM)"
            )));
        }
        let channels = match ch_count {
            1 => Channels::Mono,
            2 => Channels::Stereo,
            n => return Err(err(format!("unsupported channel count {n} (mono/stereo)"))),
        };
        if data.is_empty() {
            return Err(err("WAV carries no PCM samples"));
        }
        if data.len() % 2 != 0 {
            return Err(err("PCM payload is not i16-aligned (odd byte count)"));
        }
        let pcm: Vec<i16> = data
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();

        // Map onto a libopus-native input rate (22050 → 24000 etc.).
        let opus_rate = nearest_opus_rate(rate);
        let samples = if opus_rate != rate {
            resample_linear(&pcm, rate, opus_rate)
        } else {
            pcm
        };

        let mut enc = opus::Encoder::new(opus_rate, channels, Application::Voip)
            .map_err(|e| err(e.to_string()))?;
        enc.set_bitrate(Bitrate::Bits(
            i32::try_from(self.bitrate_bps).unwrap_or(i32::MAX),
        ))
        .map_err(|e| err(e.to_string()))?;
        // Lookahead is reported at 48 kHz (libopus semantics) — exactly the
        // granule domain, so it doubles as the OpusHead preskip.
        let lookahead = enc.get_lookahead().map_err(|e| err(e.to_string()))? as u16;

        let mut wtr = PacketWriter::new(Vec::new());

        // Header page: OpusHead alone on a forced page break, then OpusTags.
        wtr.write_packet(
            opus_head(lookahead, ch_count, rate),
            SERIAL,
            PacketWriteEndInfo::EndPage,
            0,
        )
        .map_err(|e| err(e.to_string()))?;
        wtr.write_packet(opus_tags(), SERIAL, PacketWriteEndInfo::NormalPacket, 0)
            .map_err(|e| err(e.to_string()))?;

        // Audio: whole 20 ms frames only; a partial final frame is padded
        // with silence. The last packet must carry EndStream or the writer
        // silently drops the unflushed final page (T2 gotcha #1).
        let frame_samples = opus_rate as usize / 50;
        let mut frames: Vec<Vec<i16>> =
            samples.chunks(frame_samples).map(<[i16]>::to_vec).collect();
        if let Some(tail) = frames.last().filter(|f| f.len() < frame_samples) {
            let mut padded = tail.clone();
            padded.resize(frame_samples, 0);
            let n = frames.len() - 1;
            frames[n] = padded;
        }

        let mut buf = vec![0u8; 4_000];
        let mut granule = u64::from(lookahead);
        let total = frames.len();
        for (i, frame) in frames.iter().enumerate() {
            let n = enc
                .encode(frame, &mut buf)
                .map_err(|e| err(format!("frame {i}: {e}")))?;
            // Owned copy: write_packet holds its input as a Cow borrow until
            // the page flushes, so `buf` can't be re-borrowed next frame.
            let pkt = buf[..n].to_vec();
            granule += GRANULES_PER_FRAME;
            let info = if i + 1 == total {
                PacketWriteEndInfo::EndStream
            } else {
                PacketWriteEndInfo::NormalPacket
            };
            wtr.write_packet(pkt, SERIAL, info, granule)
                .map_err(|e| err(e.to_string()))?;
        }

        Ok(wtr.into_inner())
    }

    fn codec(&self) -> AudioCodec {
        AudioCodec::Opus
    }
}

#[cfg(test)]
mod tests {
    use std::f64::consts::PI;
    use std::process::{Command, Stdio};

    use ogg::PacketReader;
    use opus::Channels;

    use super::*;
    use crate::encode::OpusEncoder;

    /// Canonical 44-byte mono-16-bit WAV around raw PCM at `rate` (the Piper
    /// shape; pcm.rs's test helper is hardcoded to 16 kHz, this one isn't).
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

    /// `secs` of a `freq` Hz sine at `rate`, amplitude 0.4 — deterministic
    /// signal the round-trip can verify by zero-crossing count.
    fn sine(rate: u32, secs: f64, freq: f64) -> Vec<i16> {
        let total = (f64::from(rate) * secs).round() as usize;
        (0..total)
            .map(|i| {
                let t = f64::from(i as u32) / f64::from(rate);
                (0.4 * (2.0 * PI * freq * t).sin() * 32767.0) as i16
            })
            .collect()
    }

    /// Demux + decode OGG/Opus back to PCM at `rate` (mono). Skips headers;
    /// asserts the first packet really is an OpusHead. Returns the samples.
    fn decode_ogg(bytes: &[u8], rate: u32) -> Vec<i16> {
        let mut rdr = PacketReader::new(std::io::Cursor::new(bytes));
        let mut dec = opus::Decoder::new(rate, Channels::Mono).expect("decoder create");
        let mut pcm = Vec::new();
        let mut first = true;
        while let Some(pkt) = rdr.read_packet().expect("read packet") {
            if first {
                assert_eq!(&pkt.data[..8], b"OpusHead", "first packet is OpusHead");
                first = false;
                continue;
            }
            if pkt.data.starts_with(b"OpusTags") {
                continue;
            }
            let mut out = vec![0i16; 5760];
            let n = dec
                .decode(&pkt.data, &mut out, false)
                .expect("decode packet");
            pcm.extend_from_slice(&out[..n]);
        }
        assert!(!first, "stream had no OpusHead");
        pcm
    }

    /// Estimated Hz of a decoded mono signal via zero-crossing count.
    fn tone_hz(pcm: &[i16], rate: u32) -> f64 {
        let crossings = pcm.windows(2).filter(|w| (w[0] < 0) != (w[1] < 0)).count() as f64;
        crossings / 2.0 / (pcm.len() as f64 / f64::from(rate))
    }

    #[test]
    fn codec_reports_opus_without_encoding() {
        assert_eq!(NativeOpusEncoder::new().codec(), AudioCodec::Opus);
    }

    #[test]
    fn default_bitrate_matches_ffmpeg_encoder() {
        assert_eq!(
            NativeOpusEncoder::DEFAULT_BITRATE,
            OpusEncoder::DEFAULT_BITRATE
        );
    }

    #[test]
    fn encode_yields_ogg_pages_bos_eos_and_opus_headers() {
        let wav = wav_bytes(&sine(16_000, 3.0, 440.0), 16_000);
        let out = NativeOpusEncoder::new().encode(&wav).unwrap();

        // OGG page structure: starts with a BOS page, ends with an EOS page.
        assert_eq!(&out[..4], b"OggS", "OGG capture pattern at byte 0");
        assert_eq!(out[5] & 0x02, 0x02, "first page is beginning-of-stream");
        let last_page = out
            .windows(4)
            .rposition(|w| w == b"OggS")
            .expect("a later page exists");
        assert_eq!(
            out[last_page + 5] & 0x04,
            0x04,
            "last page is end-of-stream"
        );

        // OpusHead carries the WAV's rate (advisory input rate) + mono.
        let mut rdr = PacketReader::new(std::io::Cursor::new(&out));
        let head = rdr.read_packet().unwrap().unwrap();
        assert_eq!(&head.data[..8], b"OpusHead");
        assert_eq!(head.data[8], 1, "version");
        assert_eq!(head.data[9], 1, "channels: mono");
        let preskip = u16::from_le_bytes(head.data[10..12].try_into().unwrap());
        assert!(preskip > 0, "preskip = encoder lookahead");
        let rate = u32::from_le_bytes(head.data[12..16].try_into().unwrap());
        assert_eq!(rate, 16_000, "OpusHead input rate is the WAV rate");
        let tags = rdr.read_packet().unwrap().unwrap();
        assert!(tags.data.starts_with(b"OpusTags"));
    }

    #[test]
    fn round_trip_preserves_duration_and_tone() {
        let rate = 16_000;
        let src = sine(rate, 3.0, 440.0);
        let out = NativeOpusEncoder::new()
            .encode(&wav_bytes(&src, rate))
            .unwrap();
        let dec = decode_ogg(&out, rate);

        let expect_lo = src.len().saturating_sub(rate as usize / 20); // −50 ms
        let expect_hi = src.len() + rate as usize / 20 + 3 * 320; // +tail/preskip slack
        assert!(
            dec.len() >= expect_lo && dec.len() <= expect_hi,
            "decoded {} samples, expected ~{} (±tail)",
            dec.len(),
            src.len()
        );
        assert!(dec.iter().map(|s| s.unsigned_abs()).max().unwrap() > 8_000);
        let est = tone_hz(&dec, rate);
        let rel = (est - 440.0) / 440.0;
        assert!(rel.abs() < 0.05, "tone drifted: {est:.1} Hz vs 440");
    }

    #[test]
    fn partial_tail_frame_is_padded_and_round_trips() {
        let rate = 16_000;
        // 0.73 s — not a whole multiple of 20 ms frames (320 samples).
        let src = sine(rate, 0.73, 440.0);
        assert_eq!(src.len() % 320, 160, "test premise: partial final frame");
        let out = NativeOpusEncoder::new()
            .encode(&wav_bytes(&src, rate))
            .unwrap();
        let dec = decode_ogg(&out, rate);
        let dur = dec.len() as f64 / f64::from(rate);
        let overshoot = dur - 0.73;
        assert!(
            (overshoot.abs() < 0.05) && dur >= 0.73,
            "duration {dur:.3} s — padded tail must not lose audio (< 20 ms overshoot)"
        );
    }

    #[test]
    fn rate_22050_encodes_via_nearest_supported_rate() {
        let rate = 22_050;
        let src = sine(rate, 1.0, 440.0);
        let out = NativeOpusEncoder::new()
            .encode(&wav_bytes(&src, rate))
            .unwrap();

        // OpusHead still advertises the original input rate (advisory).
        let mut rdr = PacketReader::new(std::io::Cursor::new(&out));
        let head = rdr.read_packet().unwrap().unwrap();
        let head_rate = u32::from_le_bytes(head.data[12..16].try_into().unwrap());
        assert_eq!(head_rate, 22_050);

        // Decode at the resampled-to rate; duration survives.
        let dec = decode_ogg(&out, 24_000);
        let dur = dec.len() as f64 / 24_000.0;
        assert!(
            (dur - 1.0).abs() < 0.05,
            "22050→24000 resample changed duration: {dur:.3} s"
        );
    }

    #[test]
    fn bitrate_target_bounds_output_size() {
        // 3 s at 24 kbps ≈ 9 KB (T2 measured 9.4 KB incl. container). The
        // default libopus auto bitrate (~64 kbps) would produce ~24 KB — this
        // trips if the bitrate flag stops being applied.
        let wav = wav_bytes(&sine(16_000, 3.0, 440.0), 16_000);
        let out = NativeOpusEncoder::new().encode(&wav).unwrap();
        assert!(
            out.len() < 15_000,
            "3 s @ 24 kbps encoded {} bytes",
            out.len()
        );
    }

    #[test]
    fn invalid_input_is_typed_error() {
        let enc = NativeOpusEncoder::new();
        let garbage = vec![0u8; 10];
        assert!(matches!(
            enc.encode(&garbage),
            Err(SynthError::NativeEncode { .. })
        ));
        // Empty data chunk: rejected, mirroring ffmpeg's empty-input error.
        let empty = wav_bytes(&[], 16_000);
        assert!(matches!(
            enc.encode(&empty),
            Err(SynthError::NativeEncode { .. })
        ));
    }

    #[test]
    #[ignore = "comparison vs local ffmpeg (T4 acceptance); no bit-exactness required"]
    fn native_vs_ffmpeg_durations_match() {
        let rate = 16_000;
        let wav = wav_bytes(&sine(rate, 3.0, 440.0), rate);

        let native_dur = {
            let bytes = NativeOpusEncoder::new().encode(&wav).unwrap();
            let dec = decode_ogg(&bytes, rate);
            dec.len() as f64 / f64::from(rate)
        };

        let ffmpeg_dur = {
            let opus_bytes = OpusEncoder::new().encode(&wav).unwrap();
            // Decode to raw 16-bit mono s16le at a fixed rate: a piped `-f
            // wav` carries a placeholder (0xFFFFFFFF) data size, so raw byte
            // count is the only trustworthy duration source.
            let mut child = Command::new("ffmpeg")
                .arg("-hide_banner")
                .arg("-loglevel")
                .arg("error")
                .arg("-i")
                .arg("pipe:0")
                .arg("-ar")
                .arg("16000")
                .arg("-ac")
                .arg("1")
                .arg("-f")
                .arg("s16le")
                .arg("pipe:1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("ffmpeg on PATH (ignored test)");
            {
                use std::io::Write;
                let mut stdin = child.stdin.take().unwrap();
                stdin.write_all(&opus_bytes).unwrap();
            }
            let out = child.wait_with_output().expect("ffmpeg decode");
            assert!(out.status.success(), "ffmpeg decode failed");
            out.stdout.len() as f64 / 32_000.0
        };

        assert!((native_dur - 3.0).abs() < 0.1, "native {native_dur:.3} s");
        assert!((ffmpeg_dur - 3.0).abs() < 0.1, "ffmpeg {ffmpeg_dur:.3} s");
        assert!(
            (native_dur - ffmpeg_dur).abs() < 0.15,
            "native {native_dur:.3} vs ffmpeg {ffmpeg_dur:.3}"
        );
    }
}
