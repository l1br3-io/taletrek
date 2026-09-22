//! The synthesis pipeline: take `(voice, text)` and produce encoded audio
//! bytes. Mirrors the SPA's `web/src/lib/tts/engine.ts` synthesize loop
//! (normalize → split → per-chunk predict → concat WAV → encode), reusing the
//! crate's [`crate::normalize`] and [`crate::cache_key`] so cache keys match
//! the SPA byte-for-byte.
//!
//! ## Injection seams
//!
//! - [`PiperRunner`] abstracts the native `piper` binary so unit tests stub
//!   it; production uses [`SubprocessPiperRunner`].
//! - [`crate::Encoder`] (defined in `encode.rs`) abstracts the audio codec so a
//!   native Opus impl can replace the ffmpeg-backed one without touching this
//!   module.
//!
//! ## Piper invocation
//!
//! [`SubprocessPiperRunner`] runs `piper --model <voice.onnx> --config
//! <voice.json> -f -`. `--config` is passed explicitly because Piper's default
//! appends `.json` to the model path (`<id>.onnx.json`), while TaleTrek's
//! layouts store the config as the sibling with the extension replaced
//! (`<id>.json`). `--output-raw` is omitted: Piper's default stdout format is
//! canonical WAV, which is what [`crate::pcm::concat_wav`] expects; passing
//! `--output-raw` would emit headerless PCM and break the splice. Text is fed
//! on stdin.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::bundle::audio::AudioCodec;
use crate::cache_key::cache_key;
use crate::encode::Encoder;
use crate::normalize::{normalize_for_speech, split_for_speech, MAX_SYNTH_CHARS};
use crate::pcm::{concat_wav, wav_duration};

/// All ways synthesis can fail. Typed so callers can branch on e.g.
/// [`SynthError::PiperMissing`] to prompt the user to install piper vs.
/// [`SynthError::Predict`] for a runtime model/text failure.
#[derive(Debug, thiserror::Error)]
pub enum SynthError {
    /// The `piper` binary could not be spawned. The host should surface
    /// "install piper" guidance.
    #[error("piper binary `{bin}` failed to start: {source}")]
    PiperMissing {
        /// The binary path/name that was attempted.
        bin: String,
        /// Underlying spawn error.
        #[source]
        source: std::io::Error,
    },

    /// Piper ran but exited non-zero, or produced no audio.
    #[error("piper predict failed (bin `{bin}`, exit code {code:?}): {stderr}")]
    Predict {
        /// The binary path/name that was attempted.
        bin: String,
        /// Process exit code (`None` if terminated by signal).
        code: Option<i32>,
        /// Captured stderr, for diagnostics.
        stderr: String,
    },

    /// Piper ran successfully but wrote no bytes to stdout.
    #[error("piper produced no audio for chunk: {chunk}")]
    EmptyOutput {
        /// The (possibly truncated) chunk text that produced no audio.
        chunk: String,
    },

    /// A voice model could not be loaded for in-process synthesis: missing
    /// model or sibling config, unreadable/invalid config, or the ONNX runtime
    /// rejected the model. Construction-time only (runners load their model
    /// once at construction); the path + reason carry enough context to branch
    /// on (re-download the voice vs. point elsewhere).
    #[error("voice model `{}` failed to load: {reason}", .path.display())]
    VoiceLoad {
        /// The `.onnx` path that was attempted.
        path: PathBuf,
        /// What went wrong (missing sibling config, rejected by the runtime…).
        reason: String,
    },

    /// The `ffmpeg` encoder binary could not be spawned.
    #[error("encoder binary `{bin}` failed to start: {source}")]
    EncoderMissing {
        /// The binary path/name that was attempted.
        bin: String,
        /// Underlying spawn error.
        #[source]
        source: std::io::Error,
    },

    /// The encoder process failed at the I/O level after spawning.
    #[error("encoder I/O failure: {0}")]
    EncoderIo(#[source] std::io::Error),

    /// The encoder ran but exited non-zero.
    #[error("encoder `{bin}` failed (exit code {code:?}): {stderr}")]
    EncoderFailed {
        /// The binary path/name that was attempted.
        bin: String,
        /// Process exit code (`None` if terminated by signal).
        code: Option<i32>,
        /// Captured stderr, for diagnostics.
        stderr: String,
    },

    /// The in-process (native) Opus encoder failed: rejected input WAV
    /// (non-16-bit, odd payload, unsupported channel count) or a
    /// libopus/OGG-level encode error.
    #[error("native opus encode failed: {reason}")]
    NativeEncode {
        /// What went wrong (WAV parse rejection or encoder error).
        reason: String,
    },

    /// Whole-book audio merge (remux) failed: the bundle is text-only, its
    /// codec is not Opus, or a segment's OGG payload is malformed/truncated.
    #[error("audio merge failed: {reason}")]
    Merge {
        /// What went wrong (missing audio, bad container, missing segment).
        reason: String,
    },

    /// The input text normalized to empty (whitespace-only). Nothing to synth.
    #[error("synthesize_paragraph received text that normalized to empty")]
    EmptyText,

    /// The host cancelled the run between paragraphs. Not a pipeline
    /// failure: the host's runner wrapper ([`PiperRunner`] decorator) checks
    /// a cooperative cancel flag before each predict and raises this so
    /// rayon's abort-on-first-error short-circuit unwinds the pool
    /// promptly. Hosts surface it as "Cancelled", not "Failed".
    #[error("cancelled")]
    Cancelled,
}

/// Synthesize one chunk of normalized text to raw PCM WAV bytes via Piper.
///
/// Implementations must return canonical WAV bytes (Piper's default stdout
/// format). The output is fed to [`crate::pcm::concat_wav`], so raw-PCM
/// emitters are not supported.
pub trait PiperRunner {
    /// Synthesize `text` using the voice model at `voice_model`. Returns the
    /// canonical WAV bytes Piper writes to stdout.
    fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError>;

    /// The largest chunk this engine should be fed in a single [`Self::predict`]
    /// call. [`synthesize_paragraph`] lowers its split cap to
    /// `min(SynthOptions::max_chars, this)` — engines can only tighten, never
    /// loosen, the host's cap.
    ///
    /// The default ([`MAX_SYNTH_CHARS`]) suits subprocess Piper, whose peak
    /// memory dies with each spawned process. Long-lived in-process engines
    /// whose inference memory grows superlinearly with input length (VITS via
    /// onnxruntime: the arena is sized by the largest request ever seen and
    /// never shrinks) override with a smaller cap to bound steady-state RSS.
    fn max_synth_chars(&self) -> usize {
        MAX_SYNTH_CHARS
    }
}

/// Run the real `piper` binary as a subprocess.
///
/// Created with [`SubprocessPiperRunner::new`] pointing at the binary (default
/// `"piper"`, resolved from `PATH`). Each [`PiperRunner::predict`] call spawns
/// one process; Piper's model-load cost (~100 ms native, far cheaper than the
/// WASM path) makes per-chunk spawning acceptable for batch synth.
pub struct SubprocessPiperRunner {
    piper_bin: PathBuf,
}

impl SubprocessPiperRunner {
    /// Construct a runner that invokes the `piper` binary at `piper_bin`.
    #[must_use]
    pub fn new(piper_bin: impl Into<PathBuf>) -> Self {
        Self {
            piper_bin: piper_bin.into(),
        }
    }
}

impl PiperRunner for SubprocessPiperRunner {
    fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
        let bin_display = self.piper_bin.to_string_lossy().into_owned();
        let mut child = Command::new(&self.piper_bin)
            .arg("--model")
            .arg(voice_model)
            // Piper's default config path is `<model-path>.json` appended, but
            // every TaleTrek layout (voice cache, e2e gate, SPA OPFS) stores the
            // config as the model's sibling with the extension *replaced*:
            // `<id>.onnx` + `<id>.json`. Point piper at it explicitly.
            .arg("--config")
            .arg(voice_model.with_extension("json"))
            // Omit --output-raw: Piper's default stdout is canonical WAV, which
            // concat_wav expects (raw PCM would lack the headers it parses).
            .arg("-f")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SynthError::PiperMissing {
                bin: bin_display.clone(),
                source: e,
            })?;

        if let Some(mut stdin) = child.stdin.take() {
            // Piper reads one inference per line; ensure a trailing newline.
            let _ = stdin.write_all(text.as_bytes());
            let _ = stdin.write_all(b"\n");
        }

        let output = child.wait_with_output().map_err(|e| SynthError::Predict {
            bin: bin_display.clone(),
            code: None,
            stderr: e.to_string(),
        })?;

        if !output.status.success() {
            return Err(SynthError::Predict {
                bin: bin_display,
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        if output.stdout.is_empty() {
            return Err(SynthError::EmptyOutput {
                chunk: text.chars().take(80).collect(),
            });
        }
        Ok(output.stdout)
    }
}

/// Output of a successful [`synthesize_paragraph`] call.
#[derive(Debug, Clone)]
pub struct SynthOutput {
    /// Content-addressed cache key (`${voice}:${NORM_VERSION}:${sha256}`),
    /// identical to what the SPA's `audioCacheKey` would produce.
    pub cache_key: String,
    /// Encoded audio bytes (codec given by [`Self::codec`]).
    pub audio: Vec<u8>,
    /// Codec of [`Self::audio`].
    pub codec: AudioCodec,
    /// Playback duration of the audio, in seconds (parsed from the concatenated
    /// WAV before encoding).
    pub duration_seconds: f64,
}

/// Bundled dependencies + tuning for [`synthesize_paragraph`]. Carries the
/// injected [`PiperRunner`] and [`Encoder`] plus the voice-model path and the
/// chunk-size cap (defaults to [`MAX_SYNTH_CHARS`]; lowered only for parity
/// experiments).
pub struct SynthOptions<'a, R: PiperRunner + ?Sized, E: Encoder + ?Sized> {
    /// Filesystem path to the Piper `.onnx` voice model.
    pub voice_model: &'a Path,
    /// The runner that performs inference.
    pub runner: &'a mut R,
    /// The encoder that compresses the concatenated WAV.
    pub encoder: &'a E,
    /// Max chars per Piper inference call.
    pub max_chars: usize,
}

impl<'a, R: PiperRunner, E: Encoder> SynthOptions<'a, R, E> {
    /// Construct with the default chunk cap (`MAX_SYNTH_CHARS`).
    #[must_use]
    pub fn new(voice_model: &'a Path, runner: &'a mut R, encoder: &'a E) -> Self {
        Self {
            voice_model,
            runner,
            encoder,
            max_chars: MAX_SYNTH_CHARS,
        }
    }

    /// Override the per-chunk char cap (parity experiments only).
    #[must_use]
    pub fn with_max_chars(mut self, max_chars: usize) -> Self {
        self.max_chars = max_chars;
        self
    }
}

/// Synthesize a paragraph of `text` in `voice_id` and return encoded audio.
///
/// Pipeline (mirrors the SPA's `engine.synthesize`, minus the cache layer which
/// the host owns):
///
/// 1. `cache_key(voice_id, text)` over the **original** text (the key
///    normalizes internally) — preserves SPA parity.
/// 2. `normalize_for_speech(text)` → cleaned.
/// 3. `split_for_speech(cleaned, opts.max_chars)` → chunks.
/// 4. For each chunk: `opts.runner.predict(opts.voice_model, chunk)` → WAV.
/// 5. `concat_wav(wavs)` → one WAV.
/// 6. `opts.encoder.encode(wav)` → codec bytes.
///
/// Empty (whitespace-only) text yields [`SynthError::EmptyText`].
pub fn synthesize_paragraph<R: PiperRunner + ?Sized, E: Encoder + ?Sized>(
    voice_id: &str,
    text: &str,
    opts: &mut SynthOptions<'_, R, E>,
) -> Result<SynthOutput, SynthError> {
    // The key is over the ORIGINAL text: cache_key normalizes internally, so
    // callers don't have to. This preserves byte-for-byte parity with the SPA.
    let key = cache_key(voice_id, text);

    let cleaned = normalize_for_speech(text);
    if cleaned.is_empty() {
        return Err(SynthError::EmptyText);
    }

    // The engine's cap only ever tightens the host's (module docs on
    // `PiperRunner::max_synth_chars`) — bounding in-process arena growth.
    let chunks = split_for_speech(&cleaned, opts.max_chars.min(opts.runner.max_synth_chars()));
    debug_assert!(
        !chunks.is_empty(),
        "split_for_speech returned no chunks for non-empty input"
    );

    // Synthesize + collect WAVs. Fall back to the cleaned text if split
    // produced no chunks (defensive — matches the SPA's `chunks[0] ?? cleaned`).
    let mut wavs: Vec<Vec<u8>> = Vec::with_capacity(chunks.len().max(1));
    if chunks.is_empty() {
        wavs.push(opts.runner.predict(opts.voice_model, &cleaned)?);
    } else {
        for chunk in &chunks {
            wavs.push(opts.runner.predict(opts.voice_model, chunk)?);
        }
    }

    let merged = concat_wav(&wavs);
    let duration_seconds = wav_duration(&merged);
    let audio = opts.encoder.encode(&merged)?;
    let codec = opts.encoder.codec();

    Ok(SynthOutput {
        cache_key: key,
        audio,
        codec,
        duration_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cheap in-process runner: returns a fixed tiny WAV regardless of input.
    struct StubRunner;
    impl PiperRunner for StubRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    fn canonical_wav(pcm: &[u8]) -> Vec<u8> {
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
        out.extend_from_slice(pcm);
        out
    }

    #[test]
    fn empty_text_errors_before_any_predict() {
        let mut runner = StubRunner;
        let encoder = crate::encode::WavPassthrough;
        let mut opts = SynthOptions::new(Path::new("/dev/null"), &mut runner, &encoder);
        let err = synthesize_paragraph("v", "   \n  ", &mut opts).unwrap_err();
        assert!(matches!(err, SynthError::EmptyText));
    }

    #[test]
    fn cancelled_renders_as_a_single_word() {
        // Hosts branch on this variant to show "Cancelled", never "Failed";
        // the display stays a plain marker so it never masquerades as a
        // pipeline failure in logs.
        assert_eq!(SynthError::Cancelled.to_string(), "cancelled");
    }

    #[test]
    fn key_is_over_original_text_not_normalized() {
        // cache_key already normalizes; feeding already-clean text vs curly
        // text must yield the same key on the output.
        let mut runner = StubRunner;
        let encoder = crate::encode::WavPassthrough;
        let mut opts = SynthOptions::new(Path::new("/dev/null"), &mut runner, &encoder);
        let a = synthesize_paragraph("v", "O'Reilly", &mut opts).unwrap();
        let b = cache_key("v", "O\u{2019}Reilly");
        assert_eq!(a.cache_key, b);
    }

    /// Records every chunk it was fed.
    struct RecordingRunner {
        chunks: Vec<String>,
        cap: usize,
    }
    impl PiperRunner for RecordingRunner {
        fn predict(&mut self, _voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
            self.chunks.push(text.to_string());
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
        fn max_synth_chars(&self) -> usize {
            self.cap
        }
    }

    #[test]
    fn runner_cap_tightens_the_host_cap() {
        // A long multi-sentence paragraph under a tightened engine cap must
        // arrive as more, smaller chunks — the mechanism that bounds
        // long-lived in-process engines' arena growth (sherpa's ORT arena is
        // sized by the largest chunk ever fed and never shrinks).
        let mut runner = RecordingRunner {
            chunks: Vec::new(),
            cap: 40,
        };
        let encoder = crate::encode::WavPassthrough;
        let text = "One sentence that is fairly short. Another sentence follows here. \
                    A third sentence rounds out the paragraph nicely.";
        let mut opts =
            SynthOptions::new(Path::new("/dev/null"), &mut runner, &encoder).with_max_chars(400);
        synthesize_paragraph("v", text, &mut opts).unwrap();
        assert!(
            runner.chunks.len() > 1,
            "tightened cap must split the paragraph, got one chunk"
        );
        assert!(
            runner.chunks.iter().all(|c| c.chars().count() <= 40),
            "every chunk must respect the engine cap: {:?}",
            runner.chunks
        );
    }

    #[test]
    fn runner_cap_cannot_loosen_the_host_cap() {
        // min(): an engine advertising a larger cap than the host's stays
        // bounded by the host's explicit `with_max_chars`.
        let mut runner = RecordingRunner {
            chunks: Vec::new(),
            cap: 4_000,
        };
        let encoder = crate::encode::WavPassthrough;
        let text = "First sentence here now. Second sentence here as well. Third one too.";
        let mut opts =
            SynthOptions::new(Path::new("/dev/null"), &mut runner, &encoder).with_max_chars(24);
        synthesize_paragraph("v", text, &mut opts).unwrap();
        assert!(
            runner.chunks.iter().all(|c| c.chars().count() <= 24),
            "host cap must win: {:?}",
            runner.chunks
        );
    }

    #[test]
    fn default_runner_cap_is_max_synth_chars() {
        assert_eq!(StubRunner.max_synth_chars(), MAX_SYNTH_CHARS);
    }
}
