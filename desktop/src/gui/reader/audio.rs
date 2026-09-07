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
//!
//! # The engine (task 005)
//!
//! [`AudioEngine`] is the platform half of the kernel contract: a
//! dedicated thread owning the output stream. The GUI sends
//! [`AudioCmd`]s — load-and-play a segment at an offset, or stop — and
//! drains [`AudioEvent`]s (load ack, drain, failure, playhead ticks);
//! the executor/sink pattern, one-way channels. Segments stream from
//! disk via [`taletrek_synth::read_audio_segment`] (never the whole
//! archive, G27's lesson) and the callback plays the decoded PCM at
//! its **native rate** — no resampling in v1; a device that refuses
//! the rate is a surfaced error riding the skip path, per the spec.
//!
//! Pause/resume ride load+stop rather than distinct wire commands:
//! pausing drops the playhead, the kernel's `Paused` record keeps the
//! offset, and resuming re-loads at that offset — one paragraph-scale
//! re-read + re-decode, the same doctrine the spec pinned for scrub.
//!
//! **Ordering invariant (the race closure):** the cpal callback never
//! sends events — it only advances the shared [`Playhead`]. Every
//! event is emitted by the engine thread itself, so events are totally
//! ordered after the commands that caused them; the `Loaded` ack is
//! sent only after the new playhead is armed. Together with the
//! pending window in [`super::playback`], that makes a stale drain
//! for a re-loaded identical segment unrepresentable rather than
//! merely unlikely.
//!
//! **Host gotchas (ALSA/Pulse):** cpal links ALSA unconditionally on
//! Linux (build-dep noted beside the Cargo entry). At runtime cpal
//! picks the default host — on modern desktops usually PulseAudio,
//! which accepts arbitrary rates; bare ALSA devices often support only
//! a fixed rate set (48 kHz typically), and a 24 kHz-only book (a
//! 22.05 kHz voice) then surfaces as a per-segment failure here
//! rather than being silently resampled — v1's documented stance.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use ogg::PacketReader;
use opus::Channels;

use taletrek_synth::read_audio_segment;

use super::playback::AudioTransport;

/// One segment's decoded audio: interleaved i16 PCM at `sample_rate`, the
/// libopus-native rate nearest the voice's original rate (Opus decode is
/// always whole-stream single-rate; 22050 Hz voices decode at 24 kHz).
#[derive(Debug)]
pub(crate) struct DecodedAudio {
    pub(crate) samples: Vec<i16>,
    pub(crate) sample_rate: u32,
    pub(crate) channels: usize,
}

/// A failed OGG/Opus decode. One sentence; no ogg/opus types leak.
#[derive(Debug, thiserror::Error)]
#[error("OGG/Opus decode failed: {0}")]
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

// ---- the engine -----------------------------------------------------------

/// How often the engine thread wakes to report the playhead and check
/// for drains — also the pause/resume offset granularity (a resume
/// repeats at most one tick's worth of audio).
const TICK_EVERY: Duration = Duration::from_millis(100);

/// One command to the audio thread — exactly the platform vocabulary
/// of [`taletrek_reader::PlayerAction`]: load-and-play, or stop.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AudioCmd {
    /// Stream `key`'s segment from disk, decode it, play from `offset`
    /// seconds in.
    Load { key: String, offset: f64 },
    /// Silence output and drop the current segment (pause or book end).
    Stop,
}

/// One event from the audio thread back to the GUI. Completion events
/// carry the segment key they belong to (the machine's stale-completion
/// check); `Loaded` is the ack that ends the pending window in
/// [`super::playback`] (see this module's ordering invariant).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AudioEvent {
    /// The commanded load succeeded; the segment is audible. `duration`
    /// is the decoded segment's full length in seconds — the platform's
    /// half of the contract (the kernel never knows segment durations).
    Loaded { key: String, duration: f64 },
    /// The segment played to its end.
    Drained { key: String },
    /// The segment could not be read, decoded, or opened on the device
    /// — the skip path.
    Failed { key: String, error: String },
    /// Playhead report: `offset` seconds into the current segment.
    Tick { key: String, offset: f64 },
}

/// The callback-side playback cursor: the decoded PCM of the current
/// paragraph plus how much of it the device has consumed. Shared
/// between the engine thread (replaces it per load, observes progress)
/// and the output callback (pulls frames). Lock discipline: every hold
/// is a bounded copy or field update — nothing blocking ever happens
/// under the lock.
#[derive(Debug)]
pub(crate) struct Playhead {
    /// The segment being played; empty when idle (stop/failed load).
    key: String,
    /// Interleaved PCM frames.
    samples: Vec<i16>,
    /// Frames consumed so far.
    pos: usize,
    /// Channel count of `samples`.
    channels: usize,
    /// `samples`' rate (Hz).
    sample_rate: u32,
    /// A device-side error report (set by the stream error callback;
    /// observed and cleared by the engine thread).
    fault: Option<String>,
}

impl Playhead {
    /// The resting cursor: nothing loaded, nothing playing.
    fn idle() -> Self {
        Self {
            key: String::new(),
            samples: Vec::new(),
            pos: 0,
            channels: 1,
            sample_rate: 48_000,
            fault: None,
        }
    }

    /// Whether a segment is loaded (and not faulted away).
    fn is_active(&self) -> bool {
        !self.key.is_empty()
    }

    /// Whether every decoded frame has been consumed — the drain
    /// condition the engine observes.
    fn at_end(&self) -> bool {
        self.pos * self.channels >= self.samples.len()
    }

    /// Seconds of the segment consumed so far.
    fn offset_secs(&self) -> f64 {
        self.pos as f64 / f64::from(self.sample_rate.max(1))
    }

    /// Arm the cursor over `audio`, skipping to `offset` seconds (a
    /// scrub or resume); an over-long offset lands at the end.
    fn from_decoded(key: &str, audio: DecodedAudio, offset: f64) -> Self {
        let frames = audio.samples.len() / audio.channels.max(1);
        let skip = (offset.max(0.0) * f64::from(audio.sample_rate)).round() as u64;
        let pos = usize::try_from(skip).unwrap_or(usize::MAX).min(frames);
        Self {
            key: key.to_owned(),
            samples: audio.samples,
            pos,
            channels: audio.channels.max(1),
            sample_rate: audio.sample_rate,
            fault: None,
        }
    }

    /// Drop the segment (stop): the callback draws silence from here.
    fn clear(&mut self) {
        self.key.clear();
        self.samples.clear();
        self.pos = 0;
        self.fault = None;
    }

    /// Fill `out` (interleaved) with the next frames, converting
    /// i16 → the device's sample type via f32. Past the end the buffer
    /// gets equilibrium silence — the stream stays warm.
    pub(crate) fn pull<T: cpal::Sample + cpal::FromSample<f32>>(&mut self, out: &mut [T]) {
        if self.channels == 0 || !self.is_active() {
            out.fill(T::from_sample(0.0));
            return;
        }
        let ch = self.channels;
        for frame in out.chunks_mut(ch) {
            let start = self.pos * ch;
            let remain = self.samples.len().saturating_sub(start);
            if remain == 0 {
                frame.fill(T::from_sample(0.0));
            } else {
                let take = remain.min(ch);
                for (i, out_smp) in frame.iter_mut().enumerate() {
                    *out_smp = if i < take {
                        T::from_sample(f32::from(self.samples[start + i]) / 32768.0)
                    } else {
                        T::from_sample(0.0)
                    };
                }
                self.pos += 1;
            }
        }
    }
}

/// The playhead as the engine and callback share it.
pub(crate) type SharedPlayhead = Arc<Mutex<Playhead>>;

/// A keep-alive for an opened output stream; dropping it stops it. The
/// engine holds the current one so a loaded segment stays audible.
/// Deliberately not `Send`: cpal's `Stream` is `!Send` on some hosts,
/// and the handle never leaves the engine thread.
pub(crate) struct DeviceHandle(
    // Never read — the box exists for its drop (releasing the stream
    // stops output); that side effect is the whole type.
    #[allow(dead_code)] Box<dyn std::any::Any>,
);

/// The output device the engine drives — [`CpalDevice`] in production,
/// a stub in tests (hardware stays out of unit tests; the real-device
/// gate is the `--ignored` test below).
pub(crate) trait OutputDevice: Send + Sync {
    /// Open an output stream pulling from `playhead` at the PCM's
    /// native rate and channel count (no resampling — a device that
    /// cannot run native is an error). Errors are one human sentence.
    fn open(
        &self,
        rate: u32,
        channels: u16,
        playhead: SharedPlayhead,
    ) -> Result<DeviceHandle, String>;
}

/// The production device: the host's default output, opened per rate
/// change (a book's voice fixes one rate, so in practice once per
/// book; the stream object stays alive between segments).
pub(crate) struct CpalDevice;

impl OutputDevice for CpalDevice {
    fn open(
        &self,
        rate: u32,
        channels: u16,
        playhead: SharedPlayhead,
    ) -> Result<DeviceHandle, String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let device = cpal::default_host()
            .default_output_device()
            .ok_or_else(|| "no audio output device found".to_owned())?;
        let supported = device
            .default_output_config()
            .map_err(|e| format!("querying the default output device failed: {e}"))?;
        let config = cpal::StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(rate),
            buffer_size: cpal::BufferSize::Default,
        };
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_output_stream(
                &config,
                callback::<f32>(playhead.clone()),
                fault_reporter(playhead.clone()),
                None,
            ),
            cpal::SampleFormat::I16 => device.build_output_stream(
                &config,
                callback::<i16>(playhead.clone()),
                fault_reporter(playhead.clone()),
                None,
            ),
            cpal::SampleFormat::U16 => device.build_output_stream(
                &config,
                callback::<u16>(playhead.clone()),
                fault_reporter(playhead),
                None,
            ),
            other => {
                return Err(format!(
                    "the audio device wants an unsupported sample format: {other:?}"
                ))
            }
        }
        .map_err(|e| {
            format!(
                "opening {rate} Hz/{channels}-channel output failed \
                 (the device may not support this rate): {e}"
            )
        })?;
        stream
            .play()
            .map_err(|e| format!("starting the output stream failed: {e}"))?;
        Ok(DeviceHandle(Box::new(stream)))
    }
}

/// The output callback: pull the next frames from the shared playhead.
fn callback<T: cpal::SizedSample + cpal::FromSample<f32>>(
    playhead: SharedPlayhead,
) -> impl FnMut(&mut [T], &cpal::OutputCallbackInfo) + Send + 'static {
    move |data, _| {
        // GOTCHA: never poison-panic from the audio callback — a prior
        // panic anywhere in this path would wedge every later lock.
        let mut ph = playhead.lock().unwrap_or_else(|p| p.into_inner());
        ph.pull(data);
    }
}

/// The stream error callback: route device death into the playhead's
/// fault slot, where the engine loop surfaces it as a segment failure
/// (the skip path) instead of dying silently mid-book.
fn fault_reporter(playhead: SharedPlayhead) -> impl FnMut(cpal::StreamError) + Send + 'static {
    move |e| {
        if let Ok(mut ph) = playhead.lock() {
            ph.fault = Some(format!("the audio device reported an error: {e}"));
        }
    }
}

/// The platform audio engine: a dedicated thread owning the output
/// stream. The GUI holds this handle, sends [`AudioCmd`]s, drains
/// [`AudioEvent`]s; dropping the handle stops the thread (joins within
/// one tick plus an in-flight decode).
pub(crate) struct AudioEngine {
    cmd_tx: Option<Sender<AudioCmd>>,
    event_rx: Receiver<AudioEvent>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl AudioEngine {
    /// Spawn the engine for the bundle at `path`, driving `device`.
    /// Constructing touches no hardware — the device opens on the
    /// first load command (a reader that never plays spawns only an
    /// idle thread; a text-only reader spawns nothing at all).
    pub(crate) fn new(path: PathBuf, device: Arc<dyn OutputDevice>) -> Self {
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
        let (event_tx, event_rx) = crossbeam_channel::unbounded();
        let playhead: SharedPlayhead = Arc::new(Mutex::new(Playhead::idle()));
        let spawn_path = path.clone();
        let handle = std::thread::Builder::new()
            .name("taletrek-audio".to_owned())
            .spawn(move || engine_loop(&spawn_path, device, cmd_rx, event_tx, playhead))
            .expect("spawn the audio thread");
        Self {
            cmd_tx: Some(cmd_tx),
            event_rx,
            handle: Some(handle),
        }
    }

    fn cmd(&self, cmd: AudioCmd) {
        if let Some(tx) = &self.cmd_tx {
            let _ = tx.send(cmd);
        }
    }
}

impl AudioTransport for AudioEngine {
    fn load(&self, key: &str, offset: f64) {
        self.cmd(AudioCmd::Load {
            key: key.to_owned(),
            offset,
        });
    }

    fn stop(&self) {
        self.cmd(AudioCmd::Stop);
    }

    fn try_event(&self) -> Option<AudioEvent> {
        self.event_rx.try_recv().ok()
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        // Drop the sender first so the loop's recv reports
        // Disconnected, then join — close never outlives the reader
        // by more than one tick plus an in-flight decode.
        self.cmd_tx = None;
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// The engine thread: serialize commands, load segments from disk,
/// arm the playhead, observe it, report. Every event emission lives
/// here (never in the callback) so events are totally ordered after
/// the commands that caused them — the ordering the pending window in
/// [`super::playback`] relies on.
fn engine_loop(
    path: &Path,
    device: Arc<dyn OutputDevice>,
    cmd_rx: Receiver<AudioCmd>,
    event_tx: Sender<AudioEvent>,
    playhead: SharedPlayhead,
) {
    // The opened stream (kept alive = the loaded segment is audible).
    let mut stream: Option<DeviceHandle> = None;
    // Whether the current playhead's drain was already reported.
    let mut reported = false;
    loop {
        match cmd_rx.recv_timeout(TICK_EVERY) {
            Ok(AudioCmd::Load { key, offset }) => {
                reported = false;
                // Silence whatever was playing before attempting the
                // load — a failed load must not leave the old segment
                // ticking behind the machine's back.
                playhead.lock().unwrap_or_else(|p| p.into_inner()).clear();
                let event =
                    load_segment(path, device.as_ref(), &key, offset, &mut stream, &playhead);
                let _ = event_tx.send(event);
            }
            Ok(AudioCmd::Stop) => {
                // Drop the segment; keep the stream warm (silence).
                playhead.lock().unwrap_or_else(|p| p.into_inner()).clear();
                reported = false;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        // Observe. A device fault beats a drain; a drain is reported
        // once; otherwise an active playhead reports its offset.
        let observed = {
            let mut ph = playhead.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(error) = ph.fault.take() {
                let key = ph.key.clone();
                ph.clear();
                reported = true;
                Some(AudioEvent::Failed { key, error })
            } else if ph.is_active() && ph.at_end() {
                if reported {
                    None
                } else {
                    reported = true;
                    Some(AudioEvent::Drained {
                        key: ph.key.clone(),
                    })
                }
            } else if ph.is_active() {
                Some(AudioEvent::Tick {
                    key: ph.key.clone(),
                    offset: ph.offset_secs(),
                })
            } else {
                None
            }
        };
        if let Some(event) = observed {
            let _ = event_tx.send(event);
        }
    }
}

/// Read + decode + device-open for one load command, yielding the event
/// to report (`Loaded` once the playhead is armed, `Failed` otherwise).
fn load_segment(
    path: &Path,
    device: &dyn OutputDevice,
    key: &str,
    offset: f64,
    stream: &mut Option<DeviceHandle>,
    playhead: &SharedPlayhead,
) -> AudioEvent {
    let failed = |error: String| AudioEvent::Failed {
        key: key.to_owned(),
        error,
    };
    let segment = match read_audio_segment(path, key) {
        Err(err) => return failed(format!("reading the bundle failed: {err}")),
        // A narrated manifest whose archive lacks this key (a segment
        // pulled out of a copy, say) — the skip path, not an error.
        Ok(None) => return failed("the bundle has no audio segment for this paragraph".to_owned()),
        Ok(Some(segment)) => segment,
    };
    let decoded = match decode_ogg_opus(&segment.bytes) {
        Ok(decoded) => decoded,
        Err(err) => return failed(err.to_string()),
    };
    let channels = u16::try_from(decoded.channels).unwrap_or(2);
    match device.open(decoded.sample_rate, channels, playhead.clone()) {
        Ok(handle) => {
            *stream = Some(handle);
            let frames = decoded.samples.len() / decoded.channels.max(1);
            let duration = frames as f64 / f64::from(decoded.sample_rate.max(1));
            *playhead.lock().unwrap_or_else(|p| p.into_inner()) =
                Playhead::from_decoded(key, decoded, offset);
            AudioEvent::Loaded {
                key: key.to_owned(),
                duration,
            }
        }
        Err(error) => failed(error),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn garbage_is_typed_error() {
        assert!(decode_ogg_opus(&[0u8; 64]).is_err());
        assert!(decode_ogg_opus(&[]).is_err());
    }

    // ---- shared fixture helpers (decode round-trip + engine) ----------

    const VOICE: &str = "en_US-amy-medium";

    /// The one paragraph every engine fixture narrates.
    const PARA: &str = "One small paragraph for the ears.";

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
                (0.4 * (2.0 * std::f64::consts::PI * freq * t).sin() * 32767.0) as i16
            })
            .collect()
    }

    /// Estimated Hz of a mono signal via zero-crossing count.
    fn tone_hz(pcm: &[i16], rate: u32) -> f64 {
        let crossings = pcm.windows(2).filter(|w| (w[0] < 0) != (w[1] < 0)).count() as f64;
        crossings / 2.0 / (pcm.len() as f64 / f64::from(rate))
    }

    /// Round-trip against our own encode path — the effort's spike gate:
    /// prove ogg+opus decode the exact bytes `NativeOpusEncoder` produces.
    #[cfg(feature = "native-encode")]
    mod round_trip {
        use super::*;
        use taletrek_synth::{Encoder, NativeOpusEncoder};

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

    // ---- playhead -------------------------------------------------------

    fn stereo_head(pairs: &[(i16, i16)]) -> Playhead {
        let mut samples = Vec::new();
        for (l, r) in pairs {
            samples.extend_from_slice(&[*l, *r]);
        }
        Playhead::from_decoded(
            "k",
            DecodedAudio {
                samples,
                sample_rate: 100,
                channels: 2,
            },
            0.0,
        )
    }

    #[test]
    fn playhead_streams_frames_in_order_and_silences_past_the_end() {
        let mut ph = stereo_head(&[(100, -100), (200, -200)]);
        assert!(!ph.at_end());

        let mut out = [0.0f32; 4];
        ph.pull(&mut out);
        let want = [
            100.0 / 32768.0,
            -100.0 / 32768.0,
            200.0 / 32768.0,
            -200.0 / 32768.0,
        ];
        assert_eq!(out, want);
        assert!(ph.at_end(), "all frames consumed");
        assert_eq!(ph.offset_secs(), 0.02, "2 frames at 100 Hz");

        // Past the end: equilibrium silence, no panic, still at end.
        ph.pull(&mut out);
        assert_eq!(out, [0.0; 4]);
        assert!(ph.at_end());
    }

    #[test]
    fn playhead_converts_to_integer_sample_types() {
        let mut ph = stereo_head(&[(1234, -1234)]);
        let mut out = [0i16; 2];
        ph.pull(&mut out);
        assert_eq!(out, [1234, -1234], "i16 PCM round-trips exactly");
    }

    #[test]
    fn playhead_starts_at_the_requested_offset() {
        let mono: Vec<i16> = (0..100).collect();
        let mut ph = Playhead::from_decoded(
            "k",
            DecodedAudio {
                samples: mono,
                sample_rate: 100,
                channels: 1,
            },
            0.5,
        );
        assert_eq!(ph.offset_secs(), 0.5, "half a second skipped at 100 Hz");

        let mut out = [0.0f32; 2];
        ph.pull(&mut out);
        assert_eq!(
            out,
            [50.0 / 32768.0, 51.0 / 32768.0],
            "playback begins at frame 50 (i16 → f32 normalized)"
        );
    }

    #[test]
    fn playhead_overlong_offset_lands_at_the_end() {
        let ph = Playhead::from_decoded(
            "k",
            DecodedAudio {
                samples: vec![7; 10],
                sample_rate: 100,
                channels: 1,
            },
            60.0,
        );
        assert!(ph.at_end(), "an over-long scrub drains immediately");
    }

    #[test]
    fn idle_playhead_silences() {
        let mut ph = Playhead::idle();
        let mut out = [0.5f32; 8];
        ph.pull(&mut out);
        assert_eq!(out, [0.0; 8]);
        assert!(!ph.is_active());
    }

    // ---- engine over a stub device --------------------------------------

    /// A device that records opens and hands the playhead back to the
    /// test, which drives `pull` in the callback's place — playback
    /// becomes synchronous and deterministic.
    #[derive(Default)]
    struct StubDevice {
        state: Mutex<StubState>,
    }

    #[derive(Default)]
    struct StubState {
        playhead: Option<SharedPlayhead>,
        rate: u32,
        channels: u16,
    }

    impl OutputDevice for StubDevice {
        fn open(
            &self,
            rate: u32,
            channels: u16,
            playhead: SharedPlayhead,
        ) -> Result<DeviceHandle, String> {
            let mut s = self.state.lock().unwrap();
            s.playhead = Some(playhead);
            s.rate = rate;
            s.channels = channels;
            Ok(DeviceHandle(Box::new(())))
        }
    }

    impl StubDevice {
        /// The playhead of the latest open (waits for the engine's first
        /// load to reach the device).
        fn wait_playhead(&self) -> SharedPlayhead {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(ph) = self.state.lock().unwrap().playhead.clone() {
                    return ph;
                }
                assert!(Instant::now() < deadline, "device was never opened");
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn last_open(&self) -> (u32, u16) {
            let s = self.state.lock().unwrap();
            (s.rate, s.channels)
        }
    }

    /// Poll the engine's event channel until an event arrives.
    fn wait_event(engine: &AudioEngine) -> AudioEvent {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(ev) = engine.try_event() {
                return ev;
            }
            assert!(Instant::now() < deadline, "no engine event within 5 s");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// A narrated one-paragraph bundle on disk carrying `segment` under
    /// the paragraph's derived key (`None` for the missing-segment test).
    #[cfg(feature = "native-encode")]
    fn narrated_bundle(segment: Option<Vec<u8>>) -> (tempfile::TempDir, PathBuf) {
        use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
        use taletrek_synth::bundle::AudioSegment;
        use taletrek_synth::{
            write_book_bundle, AudioCodec, BookBundle, ChapterText, Manifest, NORM_VERSION,
            SCHEMA_VERSION,
        };

        let key = taletrek_synth::cache_key(VOICE, PARA);
        let mut audio = HashMap::new();
        if let Some(bytes) = segment {
            audio.insert(
                key.clone(),
                AudioSegment {
                    key,
                    codec: AudioCodec::Opus,
                    bytes,
                },
            );
        }
        let bundle = BookBundle {
            manifest: Manifest {
                schema_version: SCHEMA_VERSION,
                kind: ManifestKind::Book,
                book: BookMeta {
                    id: "bk_audio".into(),
                    title: "Audio Fixture".into(),
                    author: None,
                    source_format: "txt".into(),
                    chapter_count: 1,
                    voice_id: VOICE.into(),
                    created_at: 0,
                    updated_at: 0,
                    progress_fraction: None,
                },
                audio: AudioMeta {
                    present: true,
                    codec: AudioCodec::Opus,
                    norm_version: NORM_VERSION.parse().unwrap(),
                    segment_count: audio.len().try_into().unwrap(),
                },
                generator: Generator {
                    app: "taletrek-test".into(),
                    version: "0.0.0".into(),
                },
            },
            chapters: vec![ChapterText::new("bk_audio", 0, "One", vec![PARA.into()])],
            audio,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.taletrek");
        let mut buf = Cursor::new(Vec::new());
        write_book_bundle(&bundle, &mut buf).unwrap();
        std::fs::write(&path, buf.into_inner()).unwrap();
        (dir, path)
    }

    /// The paragraph fixture's segment key (the derivation the reader
    /// and the writer share).
    #[cfg(feature = "native-encode")]
    fn para_key() -> String {
        taletrek_synth::cache_key(VOICE, PARA)
    }

    /// 0.2 s of 440 Hz at 16 kHz, encoded through the writer's own
    /// encoder (container/codec symmetry by construction).
    #[cfg(feature = "native-encode")]
    fn encoded_paragraph() -> Vec<u8> {
        use taletrek_synth::{Encoder, NativeOpusEncoder};
        NativeOpusEncoder::new()
            .encode(&wav_bytes(&sine(16_000, 0.2, 440.0), 16_000))
            .expect("encode")
    }

    #[cfg(feature = "native-encode")]
    #[test]
    fn engine_loads_streams_and_drains_a_real_segment() {
        let (_dir, path) = narrated_bundle(Some(encoded_paragraph()));
        let key = para_key();

        let stub = Arc::new(StubDevice::default());
        let engine = AudioEngine::new(path, stub.clone());
        engine.load(&key, 0.0);

        match wait_event(&engine) {
            AudioEvent::Loaded { key: k, duration } => {
                assert_eq!(k, key, "the load ack arrives once the playhead is armed");
                assert!(
                    (0.15..=0.2).contains(&duration),
                    "the ack carries the decoded length (≈0.2 s), got {duration}"
                );
            }
            other => panic!("expected a Loaded ack, got {other:?}"),
        }
        assert_eq!(
            stub.last_open(),
            (16_000, 1),
            "native rate and channel count, no resample"
        );

        // Drive the callback in two stages so a mid-play tick fires.
        let ph = stub.wait_playhead();
        let mut buf = [0.0f32; 480];
        {
            let mut cur = ph.lock().unwrap();
            for _ in 0..4 {
                cur.pull(&mut buf);
            }
        }
        std::thread::sleep(TICK_EVERY * 2);
        // A 0-offset tick fires right after Loaded (before the pulls);
        // wait for the one that reflects consumed frames.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match wait_event(&engine) {
                AudioEvent::Tick { key: k, offset } => {
                    assert_eq!(k, key);
                    if offset > 0.0 {
                        break;
                    }
                }
                other => panic!("expected a mid-play Tick, got {other:?}"),
            }
            assert!(Instant::now() < deadline, "no positive offset tick");
        }

        // Consume the rest; the engine reports the drain exactly once.
        let mut drained = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !drained {
            ph.lock().unwrap().pull(&mut buf);
            while let Some(ev) = engine.try_event() {
                match ev {
                    AudioEvent::Drained { key: k } => {
                        assert_eq!(k, key);
                        drained = true;
                    }
                    AudioEvent::Failed { error, .. } => panic!("unexpected failure: {error}"),
                    AudioEvent::Tick { .. } | AudioEvent::Loaded { .. } => {}
                }
            }
            assert!(Instant::now() < deadline, "drain never reported");
        }

        engine.stop();
        let deadline = Instant::now() + Duration::from_secs(5);
        while ph.lock().unwrap().is_active() {
            assert!(Instant::now() < deadline, "stop never dropped the segment");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(feature = "native-encode")]
    #[test]
    fn engine_resumes_a_load_at_the_commanded_offset() {
        let opus = encoded_paragraph();
        let decoded = decode_ogg_opus(&opus).expect("fixture decodes");
        let (_dir, path) = narrated_bundle(Some(opus));
        let key = para_key();

        let stub = Arc::new(StubDevice::default());
        let engine = AudioEngine::new(path, stub.clone());
        engine.load(&key, 0.1);

        match wait_event(&engine) {
            AudioEvent::Loaded { key: k, duration } => {
                assert_eq!(k, key);
                assert!((0.15..=0.2).contains(&duration));
            }
            other => panic!("expected a Loaded ack, got {other:?}"),
        }
        let ph = stub.wait_playhead();
        let mut buf = [0.0f32; 1];
        ph.lock().unwrap().pull(&mut buf);
        // 0.1 s @ 16 kHz = frame 1600: playback serves the decoded
        // source from there, not from its start.
        let want = f32::from(decoded.samples[1600]) / 32768.0;
        assert!(
            (buf[0] - want).abs() < 1e-4,
            "resumes at the offset: got {}, want {want}",
            buf[0]
        );
    }

    #[cfg(feature = "native-encode")]
    #[test]
    fn engine_surfaces_a_missing_segment_as_failed() {
        let (_dir, path) = narrated_bundle(None);
        let key = para_key();

        let engine = AudioEngine::new(path, Arc::new(StubDevice::default()));
        engine.load(&key, 0.0);

        match wait_event(&engine) {
            AudioEvent::Failed { key: k, error } => {
                assert_eq!(k, key);
                assert!(
                    error.contains("no audio segment"),
                    "names the cause: {error}"
                );
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[cfg(feature = "native-encode")]
    #[test]
    fn engine_surfaces_corrupt_segment_bytes_as_failed() {
        let (_dir, path) = narrated_bundle(Some(b"not an ogg stream at all".to_vec()));
        let key = para_key();

        let engine = AudioEngine::new(path, Arc::new(StubDevice::default()));
        engine.load(&key, 0.0);

        match wait_event(&engine) {
            AudioEvent::Failed { key: k, error } => {
                assert_eq!(k, key);
                assert!(
                    error.to_lowercase().contains("decode")
                        || error.to_lowercase().contains("opus")
                        || error.to_lowercase().contains("ogg"),
                    "names the decode failure: {error}"
                );
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    /// Real-hardware device gate: opens the default output, plays ~0.5 s of
    /// silence, asserts the device actually delivered ~0.5 s of callbacks.
    #[test]
    #[ignore = "opens the real default audio device; run manually: cargo test -p taletrek-desktop -- --ignored --nocapture"]
    fn cpal_default_output_device_plays_half_second_silence() {
        use std::sync::atomic::{AtomicUsize, Ordering};

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
