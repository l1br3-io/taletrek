//! Engine selection for `synth`/`resynth`: which TTS runner and which Opus
//! encoder a run uses.
//!
//! The defaults are **in-process**: [`RunnerSpec::Native`] (sherpa-onnx, cargo
//! feature `sherpa`) + [`DesktopEncoder::Native`] (vendored libopus, feature
//! `native-encode`) — no external binaries, no `PATH` dependence. `--piper
//! <bin>` / `--ffmpeg <bin>` demote the respective side back to the subprocess
//! engines, independently (either override alone parses).
//!
//! # Runner construction is per chunk, and lazy
//!
//! `synth_all_paragraphs` calls its runner factory once per work chunk (at
//! most `jobs` times per run). The factory must be infallible
//! (`Fn(&Path) -> R`), but [`SherpaRunner`] construction can fail — so
//! [`DesktopRunner`] defers construction to its first [`PiperRunner::predict`]
//! call, where failures surface as the typed [`SynthError::VoiceLoad`] through
//! the existing abort-on-first-error channel (missing espeak-ng-data, corrupt
//! model, …). One construction per chunk == one model load per chunk: the
//! T3-measured cost model (~212 MB per additional loaded model) that
//! [`NATIVE_DEFAULT_JOBS`] clamps.
//!
//! [`SherpaRunner`]: taletrek_synth::SherpaRunner

use std::path::{Path, PathBuf};
use std::thread::available_parallelism;

#[cfg(any(not(feature = "sherpa"), not(feature = "native-encode")))]
use anyhow::bail;
use anyhow::Result;

use taletrek_synth::synth::{PiperRunner, SynthError};
use taletrek_synth::{Encoder, OpusEncoder, SubprocessPiperRunner, MAX_SYNTH_CHARS};

/// Default `--jobs` for the in-process engine. T3's memory note: each runner
/// holds a loaded ONNX model (~237 MB for the first incl. runtime init, ~212
/// MB per additional) — 2 jobs ≈ 470 MB leaves headroom for encode + a GUI on
/// 4–8 GB machines. Explicit `--jobs` is respected as-is (the caller's memory
/// budget is their call).
pub const NATIVE_DEFAULT_JOBS: usize = 2;

/// Which TTS runner a run uses.
#[derive(Clone, Debug)]
pub enum RunnerSpec {
    /// In-process sherpa-onnx over the resolved voice model (the default;
    /// cargo feature `sherpa`).
    #[cfg(feature = "sherpa")]
    Native,
    /// Piper subprocess at this binary path (`--piper <bin>` override).
    Piper(String),
}

impl RunnerSpec {
    /// Select the runner from the `--piper` flag: `None` → in-process native
    /// engine, `Some(bin)` → subprocess override.
    ///
    /// # Errors
    /// `anyhow` error naming the fix when the native engine is requested but
    /// this build compiled without feature `sherpa`.
    pub fn select(piper: Option<&str>) -> Result<Self> {
        match piper {
            Some(bin) => Ok(Self::Piper(bin.to_string())),
            None => {
                #[cfg(feature = "sherpa")]
                {
                    Ok(Self::Native)
                }
                #[cfg(not(feature = "sherpa"))]
                {
                    bail!(
                        "this build has no in-process TTS engine (feature `sherpa` off) \
                         — pass --piper <bin> to use a Piper subprocess"
                    )
                }
            }
        }
    }

    /// Whether this spec is the in-process engine (drives the default jobs
    /// count). Always `false` in builds without feature `sherpa`.
    #[must_use]
    pub fn is_native(&self) -> bool {
        #[cfg(feature = "sherpa")]
        {
            matches!(self, Self::Native)
        }
        #[cfg(not(feature = "sherpa"))]
        {
            false
        }
    }
}

/// Which Opus encoder a run uses.
pub enum DesktopEncoder {
    /// In-process vendored libopus + OGG mux (the default; cargo feature
    /// `native-encode`).
    #[cfg(feature = "native-encode")]
    Native(taletrek_synth::NativeOpusEncoder),
    /// `ffmpeg` subprocess at this binary path (`--ffmpeg <bin>` override).
    Ffmpeg(OpusEncoder),
}

impl DesktopEncoder {
    /// Select the encoder from the `--ffmpeg` flag: `None` → in-process
    /// native encoder, `Some(bin)` → subprocess override.
    ///
    /// # Errors
    /// `anyhow` error naming the fix when the native encoder is requested but
    /// this build compiled without feature `native-encode`.
    pub fn select(ffmpeg: Option<&str>) -> Result<Self> {
        match ffmpeg {
            Some(bin) => Ok(Self::Ffmpeg(
                OpusEncoder::new().with_binary(bin.to_string()),
            )),
            None => {
                #[cfg(feature = "native-encode")]
                {
                    Ok(Self::Native(taletrek_synth::NativeOpusEncoder::new()))
                }
                #[cfg(not(feature = "native-encode"))]
                {
                    bail!(
                        "this build has no in-process Opus encoder (feature `native-encode` off) \
                         — pass --ffmpeg <bin> to use an ffmpeg subprocess"
                    )
                }
            }
        }
    }
}

impl Encoder for DesktopEncoder {
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError> {
        match self {
            #[cfg(feature = "native-encode")]
            Self::Native(e) => e.encode(wav),
            Self::Ffmpeg(e) => e.encode(wav),
        }
    }

    fn codec(&self) -> taletrek_synth::AudioCodec {
        match self {
            #[cfg(feature = "native-encode")]
            Self::Native(e) => e.codec(),
            Self::Ffmpeg(e) => e.codec(),
        }
    }
}

/// The concrete runner a chunk owns: constructed from a [`RunnerSpec`] on
/// first use (see the module doc — the factory seam is infallible, so
/// construction failures defer to the first predict and surface as
/// [`SynthError::VoiceLoad`]).
pub struct DesktopRunner {
    spec: RunnerSpec,
    /// Read only when lazily constructing the sherpa engine (feature
    /// `sherpa`); the subprocess engine takes the path per predict call.
    #[cfg_attr(not(feature = "sherpa"), allow(dead_code))]
    voice_model: PathBuf,
    inner: Option<Inner>,
}

enum Inner {
    #[cfg(feature = "sherpa")]
    Sherpa(taletrek_synth::SherpaRunner),
    Piper(SubprocessPiperRunner),
}

impl DesktopRunner {
    /// Build the not-yet-constructed runner for `spec` over `voice_model`
    /// (the resolved model path — the sherpa engine loads it lazily; the
    /// subprocess engine reads it per predict call).
    #[must_use]
    pub fn new(spec: RunnerSpec, voice_model: &Path) -> Self {
        Self {
            spec,
            voice_model: voice_model.to_path_buf(),
            inner: None,
        }
    }
}

impl PiperRunner for DesktopRunner {
    fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
        if self.inner.is_none() {
            self.inner = Some(match &self.spec {
                #[cfg(feature = "sherpa")]
                RunnerSpec::Native => Inner::Sherpa(native_runner(&self.voice_model)?),
                RunnerSpec::Piper(bin) => Inner::Piper(SubprocessPiperRunner::new(bin)),
            });
        }
        match self.inner.as_mut().expect("initialized above") {
            #[cfg(feature = "sherpa")]
            Inner::Sherpa(r) => r.predict(voice_model, text),
            Inner::Piper(r) => r.predict(voice_model, text),
        }
    }

    /// Forward the selected engine's cap — the sherpa bound must survive the
    /// lazy wrapper, because split planning asks before any model loads.
    fn max_synth_chars(&self) -> usize {
        match &self.spec {
            #[cfg(feature = "sherpa")]
            RunnerSpec::Native => taletrek_synth::SHERPA_MAX_SYNTH_CHARS,
            RunnerSpec::Piper(_) => MAX_SYNTH_CHARS,
        }
    }
}

/// Construct the sherpa runner over `voice_model`: espeak-ng-data at
/// `$TALETREK_ESPEAK_DATA` when set, else the default cache location
/// (`<cache>/taletrek/espeak-ng-data`). The env override mirrors
/// `TALETREK_VOICE_PATH` — the same seam the e2e gates wire.
#[cfg(feature = "sherpa")]
fn native_runner(voice_model: &Path) -> Result<taletrek_synth::SherpaRunner, SynthError> {
    match std::env::var_os("TALETREK_ESPEAK_DATA") {
        Some(dir) => taletrek_synth::SherpaRunner::with_espeak_data(voice_model, Path::new(&dir)),
        None => taletrek_synth::SherpaRunner::new(voice_model),
    }
}

/// Resolve the effective job count: explicit `--jobs` wins; otherwise the
/// engine default — [`NATIVE_DEFAULT_JOBS`] for the in-process engine
/// (per-model memory), the CPU count for the stateless subprocess engine.
#[must_use]
pub fn effective_jobs(jobs_flag: Option<usize>, spec: &RunnerSpec) -> usize {
    jobs_flag.unwrap_or(match spec.is_native() {
        true => NATIVE_DEFAULT_JOBS,
        false => subprocess_default_jobs(),
    })
}

/// The subprocess engine's default: the number of available parallel workers,
/// falling back to 1 when the platform can't report it.
fn subprocess_default_jobs() -> usize {
    available_parallelism().map(|n| n.get()).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    use taletrek_synth::AudioCodec;

    /// Canonical mono 16-bit 16 kHz WAV with a little PCM — encoder-shape
    /// only, contents arbitrary.
    fn canonical_wav() -> Vec<u8> {
        let pcm = [0x01u8, 0x02, 0x03, 0x04];
        let data_len = u32::try_from(pcm.len()).unwrap();
        let mut out = Vec::with_capacity(44 + pcm.len());
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&16_000u32.to_le_bytes());
        out.extend_from_slice(&32_000u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.extend_from_slice(&pcm);
        out
    }

    #[test]
    fn select_defaults_to_the_native_runner() {
        assert!(RunnerSpec::select(None)
            .expect("native default")
            .is_native());
    }

    #[test]
    fn select_piper_flag_switches_to_subprocess() {
        let spec = RunnerSpec::select(Some("/opt/piper/piper")).expect("override parses");
        assert!(!spec.is_native());
        assert!(matches!(spec, RunnerSpec::Piper(bin) if bin == "/opt/piper/piper"));
    }

    #[test]
    fn select_ffmpeg_flag_switches_the_encoder_independently() {
        let enc = DesktopEncoder::select(Some("ffmpeg")).expect("override parses");
        assert!(matches!(enc, DesktopEncoder::Ffmpeg(_)));
        assert_eq!(enc.codec(), AudioCodec::Opus);
    }

    #[test]
    fn default_encoder_encodes_opus_in_process() {
        // The None-default must be the native encoder and actually encode:
        // canonical WAV in → OGG/Opus bytes out (proves the enum delegates to
        // the vendored libopus, hermetically).
        let enc = DesktopEncoder::select(None).expect("native default");
        let out = enc.encode(&canonical_wav()).expect("encode succeeds");
        assert!(out.starts_with(b"OggS"), "OGG magic, got {:?}", &out[..4]);
        assert_eq!(enc.codec(), AudioCodec::Opus);
    }

    #[test]
    fn native_jobs_default_is_two_subprocess_is_cpu_count() {
        let native = RunnerSpec::select(None).expect("native default");
        assert_eq!(effective_jobs(None, &native), NATIVE_DEFAULT_JOBS);
        assert_eq!(effective_jobs(None, &native), 2);

        let sub = RunnerSpec::select(Some("piper")).expect("subprocess");
        let cpus = available_parallelism().map(|n| n.get()).unwrap_or(1);
        assert_eq!(effective_jobs(None, &sub), cpus);
    }

    #[test]
    fn explicit_jobs_is_respected_for_both_engines() {
        let native = RunnerSpec::select(None).expect("native default");
        let sub = RunnerSpec::select(Some("piper")).expect("subprocess");
        assert_eq!(effective_jobs(Some(8), &native), 8);
        assert_eq!(effective_jobs(Some(8), &sub), 8);
    }

    #[test]
    fn lazy_native_runner_surfaces_construction_failure_as_voice_load() {
        // A native runner over a nonexistent model must fail at first predict
        // with the typed VoiceLoad error (not a panic, not a subprocess
        // error) — the deferred-construction contract.
        let spec = RunnerSpec::select(None).expect("native default");
        let mut runner = DesktopRunner::new(spec, Path::new("/nonexistent/voice.onnx"));
        let err = runner
            .predict(Path::new("/nonexistent/voice.onnx"), "hello")
            .expect_err("construction must fail at first predict");
        assert!(
            matches!(err, SynthError::VoiceLoad { .. }),
            "expected VoiceLoad, got {err:?}"
        );
        // Still failing on retry (no half-initialized state).
        assert!(runner
            .predict(Path::new("/nonexistent/voice.onnx"), "hello")
            .is_err());
    }

    #[test]
    fn native_runner_forwards_the_sherpa_chunk_cap_before_construction() {
        // The arena bound (sherpa's 120-char cap, SHERPA_MAX_SYNTH_CHARS) must
        // be visible through the lazy wrapper BEFORE the inner runner exists —
        // split planning happens ahead of first predict. A wrapper that
        // reported the trait default (400) would let 400-char chunks snap the
        // ORT arena to its high-water mark (the LMK crash class).
        let spec = RunnerSpec::select(None).expect("native default");
        let runner = DesktopRunner::new(spec, Path::new("/nonexistent/voice.onnx"));
        assert!(
            runner.inner.is_none(),
            "cap must be answerable without constructing the engine"
        );
        assert_eq!(
            runner.max_synth_chars(),
            taletrek_synth::SHERPA_MAX_SYNTH_CHARS
        );
        assert_eq!(runner.max_synth_chars(), 120);
    }

    #[test]
    fn piper_runner_keeps_the_default_chunk_cap() {
        let spec = RunnerSpec::select(Some("piper")).expect("subprocess");
        let runner = DesktopRunner::new(spec, Path::new("/dev/null"));
        assert_eq!(
            runner.max_synth_chars(),
            taletrek_synth::MAX_SYNTH_CHARS,
            "subprocess piper keeps the 400-char default"
        );
    }
}
