//! In-process TTS runner: the official `sherpa-onnx` crate (k2-fsa,
//! Apache-2.0) implementing [`PiperRunner`] — the engine-swap counterpart to
//! [`crate::SubprocessPiperRunner`] (which stays as the `--piper` override).
//!
//! # Feature + linking (from the T1 spike verdict)
//!
//! Only compiled under cargo feature `sherpa`. The crate's default features
//! statically link a **prebuilt** `sherpa-onnx` (onnxruntime + espeak-ng +
//! piper_phonemize) downloaded from k2-fsa GitHub releases into
//! `target/sherpa-onnx-prebuilt/` — **no cmake, no libclang, no system
//! onnxruntime**; plain `cargo build` with network on first build only.
//! Offline builds: `SHERPA_ONNX_ARCHIVE_DIR` / `SHERPA_ONNX_LIB_DIR`. Cost:
//! ~36 MB added to the binary. `unsafe_code` stays forbidden in this crate —
//! the crate's own `unsafe impl Send/Sync for OfflineTts` covers worker-pool
//! use.
//!
//! # Cost model (T1 measurements, feeds `--jobs` guidance in the effort spec)
//!
//! Each runner loads its own ONNX model at construction (~1 s, ~212 MB
//! steady-state RSS per additional model; the first model costs ~237 MB incl.
//! one-time onnxruntime arena init). Two runners ≈ 470 MB, four ≈ 870 MB.
//! Hosts wire one runner **per pool chunk**: `synth_all_paragraphs` calls
//! `make_runner` once per chunk (at most `--jobs` times per run), never per
//! paragraph.
//!
//! # Bridging cached Piper voices (the T1 gotchas)
//!
//! - **tokens.txt** is derived from the sibling `.onnx.json`'s
//!   `phoneme_id_map` (`<symbol> <first-id>` per line — verified byte-identical
//!   to k2-fsa's shipped tokens.txt), written into a runner-owned temp dir.
//! - **espeak-ng-data** (19 MB, voice-independent) must exist on disk; the
//!   default location is `<cache>/taletrek/espeak-ng-data`
//!   ([`default_espeak_data_dir`]); override with
//!   [`SherpaRunner::with_espeak_data`].
//! - **ONNX metadata:** sherpa's VITS init requires a `sample_rate` custom
//!   metadata entry. The diffusionStudio-mirror files the voice cache seeds
//!   carry **no** metadata at all; k2-fsa-mirror files carry 7 entries
//!   (~131 B). When `sample_rate` is absent, the runner appends the k2-fsa
//!   metadata set — every value derived from the sibling `.onnx.json` — to a
//!   **temp-dir copy** (never mutating the cached file) and loads that.
//!   Metadata-carrying models pass through zero-copy.

use std::fs;
use std::path::{Path, PathBuf};

use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig,
    OfflineTtsVitsModelConfig,
};

use crate::synth::{PiperRunner, SynthError};

/// Engine name stamped into [`SynthError::Predict`] when the in-process
/// engine fails at generate time (the subprocess variant puts the binary
/// path there).
const ENGINE: &str = "sherpa-onnx";

/// Piper-json inference defaults, used when the json omits a scale.
const DEFAULT_NOISE_SCALE: f32 = 0.667;
const DEFAULT_NOISE_SCALE_W: f32 = 0.8;
const DEFAULT_LENGTH_SCALE: f32 = 1.0;

/// In-process TTS runner over a Piper voice model, via `sherpa-onnx`.
///
/// The model loads **once per runner** at construction
/// ([`SherpaRunner::with_espeak_data`]); every [`PiperRunner::predict`] call
/// reuses it. [`PiperRunner`]'s per-call `voice_model` argument is ignored —
/// the construction-time model is authoritative (the argument exists for the
/// subprocess impl's spawn-per-call shape); debug builds assert the paths
/// match so mis-wiring (a host constructing with one model and predicting
/// with another) is caught in tests.
///
/// Construction needs, alongside the `.onnx`:
/// - its sibling `<stem>.json` config (same layout convention as the
///   subprocess path — every TaleTrek voice layout stores it that way), and
/// - an `espeak-ng-data` directory (see [`default_espeak_data_dir`]).
pub struct SherpaRunner {
    tts: OfflineTts,
    voice_model: PathBuf,
    /// Keeps the derived `tokens.txt` (+ the stamped model copy, if one was
    /// needed) alive for the runner's lifetime; removed on drop.
    _workdir: tempfile::TempDir,
}

impl SherpaRunner {
    /// Construct with espeak-ng-data at the default cache location
    /// ([`default_espeak_data_dir`]).
    ///
    /// # Errors
    /// [`SynthError::VoiceLoad`] when no platform cache dir is discoverable;
    /// otherwise whatever [`SherpaRunner::with_espeak_data`] reports.
    pub fn new(voice_model: &Path) -> Result<Self, SynthError> {
        let data = default_espeak_data_dir().ok_or_else(|| SynthError::VoiceLoad {
            path: voice_model.to_path_buf(),
            reason: "no platform cache dir discovered for espeak-ng-data; \
                     use SherpaRunner::with_espeak_data"
                .into(),
        })?;
        Self::with_espeak_data(voice_model, &data)
    }

    /// Construct with an explicit `espeak-ng-data` directory (the
    /// voice-independent espeak frontend data sherpa needs at runtime).
    ///
    /// Loads the ONNX model immediately; all input validation and load
    /// failures surface as [`SynthError::VoiceLoad`] carrying the model path
    /// and a concrete reason (missing sibling json, unreadable config,
    /// runtime rejection — including models whose missing metadata cannot be
    /// repaired from the json).
    ///
    /// # Errors
    /// [`SynthError::VoiceLoad`] on any construction failure.
    pub fn with_espeak_data(voice_model: &Path, espeak_data: &Path) -> Result<Self, SynthError> {
        let err = |reason: String| SynthError::VoiceLoad {
            path: voice_model.to_path_buf(),
            reason,
        };

        if !voice_model.is_file() {
            return Err(err(format!(
                "model file `{}` does not exist",
                voice_model.display()
            )));
        }
        let json_path = voice_model.with_extension("json");
        if !json_path.is_file() {
            return Err(err(format!(
                "no sibling config `{}` (the `.json` must sit next to the `.onnx`)",
                json_path.display()
            )));
        }
        if !espeak_data.is_dir() {
            return Err(err(format!(
                "espeak-ng-data dir `{}` does not exist",
                espeak_data.display()
            )));
        }

        let json_str = fs::read_to_string(&json_path)
            .map_err(|e| err(format!("reading `{}`: {e}", json_path.display())))?;
        let json: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| err(format!("invalid config `{}`: {e}", json_path.display())))?;
        let cfg = parse_voice_config(&json).map_err(err)?;

        let workdir =
            tempfile::tempdir().map_err(|e| err(format!("creating runner workdir: {e}")))?;

        // tokens.txt derived from the json's phoneme_id_map into the workdir.
        let tokens_path = workdir.path().join("tokens.txt");
        fs::write(&tokens_path, render_tokens_txt(&json))
            .map_err(|e| err(format!("writing tokens file: {e}")))?;

        // Point sherpa at the cached model directly when it already carries
        // the metadata sherpa needs; otherwise stamp a copy (never the cache
        // file itself) with the metadata set derived from the json.
        let mut model_bytes = fs::read(voice_model)
            .map_err(|e| err(format!("reading `{}`: {e}", voice_model.display())))?;
        let model_path = if onnx_metadata_props(&model_bytes)
            .iter()
            .any(|(k, _)| k == "sample_rate")
        {
            voice_model.to_path_buf()
        } else {
            append_metadata_prop(&mut model_bytes, "model_type", "vits");
            append_metadata_prop(&mut model_bytes, "comment", "piper");
            if let Some(language) = &cfg.language_name {
                append_metadata_prop(&mut model_bytes, "language", language);
            }
            append_metadata_prop(&mut model_bytes, "voice", &cfg.espeak_voice);
            append_metadata_prop(&mut model_bytes, "has_espeak", "1");
            append_metadata_prop(
                &mut model_bytes,
                "n_speakers",
                &cfg.num_speakers.to_string(),
            );
            append_metadata_prop(
                &mut model_bytes,
                "sample_rate",
                &cfg.sample_rate.to_string(),
            );
            let stamped = workdir.path().join("model.stamped.onnx");
            fs::write(&stamped, &model_bytes)
                .map_err(|e| err(format!("writing stamped model copy: {e}")))?;
            stamped
        };

        let to_str = |p: &Path| p.to_string_lossy().into_owned();
        let config = OfflineTtsConfig {
            model: OfflineTtsModelConfig {
                vits: OfflineTtsVitsModelConfig {
                    model: Some(to_str(&model_path)),
                    tokens: Some(to_str(&tokens_path)),
                    data_dir: Some(to_str(espeak_data)),
                    noise_scale: cfg.noise_scale,
                    noise_scale_w: cfg.noise_scale_w,
                    length_scale: cfg.length_scale,
                    ..Default::default()
                },
                // One runner per host thread — inner threading would
                // oversubscribe under the rayon pool.
                num_threads: 1,
                ..Default::default()
            },
            ..Default::default()
        };

        // `OfflineTts::create` returns `None` on load failure, but the C++
        // layer can also abort on malformed input — keep both inside the
        // VoiceLoad error, never a panic across the crate boundary.
        let tts =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| OfflineTts::create(&config)))
                .map_err(|p| err(format!("model load panicked: {}", panic_message(&p))))?
                .ok_or_else(|| {
                    err("sherpa-onnx rejected the model (create returned null)".to_string())
                })?;

        Ok(Self {
            tts,
            voice_model: voice_model
                .canonicalize()
                .unwrap_or_else(|_| voice_model.to_path_buf()),
            _workdir: workdir,
        })
    }
}

impl PiperRunner for SherpaRunner {
    fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
        // The model is fixed at construction (loads once per runner — module
        // docs); the trait's per-call path is a no-op here. Debug builds
        // assert the wiring passes the same model the runner loaded.
        debug_assert_eq!(
            voice_model.canonicalize().ok(),
            Some(self.voice_model.clone()),
            "SherpaRunner loaded `{}` but predict was called with `{}`",
            self.voice_model.display(),
            voice_model.display()
        );

        // sherpa's CString conversion panics on interior NULs — strip them.
        let text = text.replace('\0', "");
        if text.trim().is_empty() {
            return Err(SynthError::EmptyOutput {
                chunk: text.chars().take(80).collect(),
            });
        }

        let gen = GenerationConfig {
            speed: 1.0,
            sid: 0,
            ..Default::default()
        };
        let audio = self
            .tts
            .generate_with_config(&text, &gen, None::<fn(&[f32], f32) -> bool>)
            .ok_or_else(|| SynthError::Predict {
                bin: ENGINE.to_string(),
                code: None,
                stderr: "tts generate returned no audio".to_string(),
            })?;

        let samples = audio.samples();
        if samples.is_empty() {
            return Err(SynthError::EmptyOutput {
                chunk: text.chars().take(80).collect(),
            });
        }

        let sample_rate = u32::try_from(audio.sample_rate()).unwrap_or(0);
        Ok(pcm16_wav(samples, sample_rate))
    }
}

/// The default espeak-ng-data location: `<platform cache>/taletrek/
/// espeak-ng-data` (sibling of the `voices/` cache the CLI seeds). Hosts
/// seed it once (voice-independent, ~19 MB); `None` when the platform
/// exposes no discoverable cache home.
#[must_use]
pub fn default_espeak_data_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("taletrek").join("espeak-ng-data"))
}

/// The subset of the sibling `.onnx.json` the runner needs.
#[derive(Debug)]
struct VoiceConfig {
    sample_rate: u32,
    espeak_voice: String,
    language_name: Option<String>,
    num_speakers: u32,
    noise_scale: f32,
    noise_scale_w: f32,
    length_scale: f32,
}

/// Extract [`VoiceConfig`] from a parsed piper `.onnx.json`. `Err` carries a
/// concrete reason for [`SynthError::VoiceLoad`]; every required miss names
/// the json path that was absent.
fn parse_voice_config(json: &serde_json::Value) -> Result<VoiceConfig, String> {
    let sample_rate = json
        .pointer("/audio/sample_rate")
        .and_then(serde_json::Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or("config is missing `audio.sample_rate`")?;
    let espeak_voice = json
        .pointer("/espeak/voice")
        .and_then(serde_json::Value::as_str)
        .ok_or("config is missing `espeak.voice`")?
        .to_string();
    if !json
        .pointer("/phoneme_id_map")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|m| !m.is_empty())
    {
        return Err("config is missing a non-empty `phoneme_id_map`".to_string());
    }
    let num_speakers = json
        .pointer("/num_speakers")
        .and_then(serde_json::Value::as_u64)
        .map_or(1, |v| u32::try_from(v).unwrap_or(1));
    let inference = |key: &str, default: f32| {
        json.pointer(&format!("/inference/{key}"))
            .and_then(serde_json::Value::as_f64)
            .map_or(default, |v| v as f32)
    };
    Ok(VoiceConfig {
        sample_rate,
        espeak_voice,
        language_name: json
            .pointer("/language/name_native")
            .or_else(|| json.pointer("/language/name_english"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        num_speakers,
        noise_scale: inference("noise_scale", DEFAULT_NOISE_SCALE),
        noise_scale_w: inference("noise_w", DEFAULT_NOISE_SCALE_W),
        length_scale: inference("length_scale", DEFAULT_LENGTH_SCALE),
    })
}

/// Render sherpa's `tokens.txt` from the piper json: one `<symbol> <id>` pair
/// per line (the phoneme's first id), trailing newline — verified by the T1
/// spike to be byte-identical to k2-fsa's shipped tokens.txt.
fn render_tokens_txt(json: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(map) = json
        .pointer("/phoneme_id_map")
        .and_then(serde_json::Value::as_object)
    {
        for (symbol, ids) in map {
            if let Some(id) = ids
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_i64())
            {
                out.push_str(&format!("{symbol} {id}\n"));
            }
        }
    }
    out
}

/// Serialize f32 samples as a canonical mono 16-bit PCM WAV (44-byte RIFF
/// header — the exact shape [`crate::pcm::concat_wav`] splices). Conversion
/// matches Piper's own WAV writer: clamp to ±1, then scale by 32767 with
/// truncation toward zero.
fn pcm16_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = u32::try_from(samples.len().saturating_mul(2)).unwrap_or(u32::MAX);
    let byte_rate = sample_rate.saturating_mul(2);
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let scaled = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&scaled.to_le_bytes());
    }
    out
}

/// Read a protobuf varint starting at `i`; `None` on truncation or overrun.
fn read_varint(bytes: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let mut val = 0u64;
    let mut shift = 0u32;
    loop {
        let b = *bytes.get(i)?;
        i += 1;
        val |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some((val, i));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

/// Collect the `metadata_props` (ONNX ModelProto field 14: repeated
/// `{key=1, value=2}` entries) from raw model bytes — a single linear wire
/// walk, no protobuf dep. Malformed input yields whatever was collected
/// before the break (a corrupt model fails later at runtime load anyway).
fn onnx_metadata_props(bytes: &[u8]) -> Vec<(String, String)> {
    let mut props = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let Some((tag, j)) = read_varint(bytes, i) else {
            break;
        };
        let field = tag >> 3;
        match tag & 7 {
            0 => {
                let Some((_, k)) = read_varint(bytes, j) else {
                    break;
                };
                i = k;
            }
            1 => {
                i = match j.checked_add(8) {
                    Some(k) if k <= bytes.len() => k,
                    _ => break,
                }
            }
            5 => {
                i = match j.checked_add(4) {
                    Some(k) if k <= bytes.len() => k,
                    _ => break,
                }
            }
            2 => {
                let Some((len, k)) = read_varint(bytes, j) else {
                    break;
                };
                let Some(end) = k.checked_add(len as usize) else {
                    break;
                };
                if end > bytes.len() {
                    break;
                }
                if field == 14 {
                    if let Some(entry) = parse_metadata_entry(&bytes[k..end]) {
                        props.push(entry);
                    }
                }
                i = end;
            }
            _ => break,
        }
    }
    props
}

/// Parse one `StringStringEntryProto` payload (`key` field 1, `value` field
/// 2, both length-delimited) into a pair.
fn parse_metadata_entry(payload: &[u8]) -> Option<(String, String)> {
    let mut key = None;
    let mut value = None;
    let mut i = 0usize;
    while i < payload.len() {
        let Some((tag, j)) = read_varint(payload, i) else {
            break;
        };
        let field = tag >> 3;
        match tag & 7 {
            2 => {
                let Some((len, k)) = read_varint(payload, j) else {
                    break;
                };
                let end = k.checked_add(len as usize)?;
                if end > payload.len() {
                    return None;
                }
                let text = String::from_utf8_lossy(&payload[k..end]).into_owned();
                match field {
                    1 => key = Some(text),
                    2 => value = Some(text),
                    _ => {}
                }
                i = end;
            }
            0 => {
                let Some((_, k)) = read_varint(payload, j) else {
                    break;
                };
                i = k;
            }
            1 => i = j.checked_add(8).filter(|k| *k <= payload.len())?,
            5 => i = j.checked_add(4).filter(|k| *k <= payload.len())?,
            _ => return None,
        }
    }
    Some((key.unwrap_or_default(), value.unwrap_or_default()))
}

/// Append a varint length-delimited field (`tag`, payload) to `out`.
fn append_len_delim(out: &mut Vec<u8>, tag: u8, payload: &[u8]) {
    out.push(tag);
    append_varint(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

/// Encode `v` as a protobuf varint.
fn append_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// Append one ONNX `metadata_props` entry (ModelProto field 14) to raw model
/// bytes. Protobuf parsers accept fields in any order and repeated fields
/// anywhere, so appending to a serialized model is legal — this is exactly
/// how the k2-fsa mirror files differ from the metadata-less originals
/// (+~131 B of appended entries).
fn append_metadata_prop(out: &mut Vec<u8>, key: &str, value: &str) {
    let mut entry = Vec::with_capacity(key.len() + value.len() + 8);
    append_len_delim(&mut entry, 0x0a, key.as_bytes()); // key: field 1, wire 2
    append_len_delim(&mut entry, 0x12, value.as_bytes()); // value: field 2, wire 2
    append_len_delim(out, 0x72, &entry); // metadata_props: field 14, wire 2
}

/// Render a caught panic payload as a message string.
fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

#[cfg(all(test, feature = "sherpa"))]
mod tests {
    use super::*;

    // ---- WAV serialization (pure) ----

    #[test]
    fn pcm16_wav_writes_canonical_header() {
        let wav = pcm16_wav(&[0.0, 1.0, -1.0], 22_050);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            22_050,
            "sample rate serialized from the model"
        );
        assert_eq!(
            u32::from_le_bytes([wav[28], wav[29], wav[30], wav[31]]),
            22_050 * 2,
            "byte rate"
        );
        assert_eq!(u16::from_le_bytes([wav[32], wav[33]]), 2, "block align");
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "bits");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(wav.len(), 44 + 6);
    }

    #[test]
    fn pcm16_wav_clamps_and_truncates_like_piper() {
        let wav = pcm16_wav(&[1.5, -2.0, 0.5, -0.5], 16_000);
        let sample = |i: usize| i16::from_le_bytes([wav[44 + i * 2], wav[45 + i * 2]]);
        assert_eq!(sample(0), 32767, "clamped high");
        assert_eq!(sample(1), -32767, "clamped low");
        assert_eq!(sample(2), 16383, "0.5 truncated toward zero");
        assert_eq!(sample(3), -16383);
    }

    #[test]
    fn pcm16_wav_empty_samples_is_header_only() {
        let wav = pcm16_wav(&[], 22_050);
        assert_eq!(wav.len(), 44);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 0);
    }

    // ---- ONNX metadata scan + stamp (pure) ----

    /// A minimal fake ModelProto: one graph-shaped field (7) + the given
    /// metadata entries, built with the same wire helpers the stamp uses.
    fn fake_onnx(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        append_len_delim(&mut buf, 0x3a, b"graph-bytes"); // field 7, wire 2
        for (k, v) in entries {
            append_metadata_prop(&mut buf, k, v);
        }
        buf
    }

    #[test]
    fn onnx_scan_finds_metadata_props() {
        let bytes = fake_onnx(&[("model_type", "vits"), ("sample_rate", "22050")]);
        assert_eq!(
            onnx_metadata_props(&bytes),
            vec![
                ("model_type".to_string(), "vits".to_string()),
                ("sample_rate".to_string(), "22050".to_string()),
            ]
        );
    }

    #[test]
    fn onnx_scan_reports_nothing_when_absent() {
        // Graph bytes only — the diffusionStudio-cache shape: no field 14.
        let mut buf = Vec::new();
        append_len_delim(&mut buf, 0x3a, b"graph-bytes");
        assert!(onnx_metadata_props(&buf).is_empty());
    }

    #[test]
    fn stamping_appends_entries_the_scan_can_read_back() {
        let mut bytes = fake_onnx(&[]);
        for (k, v) in [
            ("model_type", "vits"),
            ("comment", "piper"),
            ("language", "English"),
            ("voice", "en-us"),
            ("has_espeak", "1"),
            ("n_speakers", "1"),
            ("sample_rate", "22050"),
        ] {
            append_metadata_prop(&mut bytes, k, v);
        }
        let props = onnx_metadata_props(&bytes);
        assert_eq!(props.len(), 7);
        assert!(props.contains(&("sample_rate".to_string(), "22050".to_string())));
    }

    // ---- tokens derivation (pure) ----

    #[test]
    fn tokens_txt_renders_symbol_id_pairs_with_trailing_newline() {
        // serde_json's default map is ordered; the map literal below lists
        // symbols out of order to pin that ordering follows the json's own
        // iteration (sorted), matching the spike's byte-identical output.
        let json: serde_json::Value =
            serde_json::from_str(r#"{"phoneme_id_map": {"z": [26], "a": [1], "_": [0]}}"#).unwrap();
        assert_eq!(render_tokens_txt(&json), "_ 0\na 1\nz 26\n");
    }

    // ---- voice-config parsing (pure) ----

    fn full_config_json() -> serde_json::Value {
        serde_json::from_str(
            r#"{
                "audio": {"sample_rate": 22050},
                "espeak": {"voice": "en-us"},
                "language": {"name_native": "English"},
                "num_speakers": 1,
                "inference": {"noise_scale": 0.6, "noise_w": 0.7, "length_scale": 1.1},
                "phoneme_id_map": {"a": [1]}
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn voice_config_reads_scales_and_required_fields() {
        let cfg = parse_voice_config(&full_config_json()).unwrap();
        assert_eq!(cfg.sample_rate, 22_050);
        assert_eq!(cfg.espeak_voice, "en-us");
        assert_eq!(cfg.language_name.as_deref(), Some("English"));
        assert_eq!(cfg.num_speakers, 1);
        assert!((cfg.noise_scale - 0.6).abs() < 1e-6);
        assert!((cfg.noise_scale_w - 0.7).abs() < 1e-6);
        assert!((cfg.length_scale - 1.1).abs() < 1e-6);
    }

    #[test]
    fn voice_config_falls_back_to_piper_defaults() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{
                "audio": {"sample_rate": 16000},
                "espeak": {"voice": "en-gb"},
                "phoneme_id_map": {"a": [1]}
            }"#,
        )
        .unwrap();
        let cfg = parse_voice_config(&json).unwrap();
        assert!((cfg.noise_scale - DEFAULT_NOISE_SCALE).abs() < 1e-6);
        assert!((cfg.noise_scale_w - DEFAULT_NOISE_SCALE_W).abs() < 1e-6);
        assert!((cfg.length_scale - DEFAULT_LENGTH_SCALE).abs() < 1e-6);
        assert_eq!(cfg.num_speakers, 1, "num_speakers defaults to 1");
        assert_eq!(cfg.language_name, None);
    }

    #[test]
    fn voice_config_names_the_missing_required_field() {
        for (json, needle) in [
            (r#"{"espeak": {"voice": "en-us"}, "phoneme_id_map": {"a": [1]}}"#.to_string(), "audio.sample_rate"),
            (r#"{"audio": {"sample_rate": 22050}, "phoneme_id_map": {"a": [1]}}"#.to_string(), "espeak.voice"),
            (r#"{"audio": {"sample_rate": 22050}, "espeak": {"voice": "en-us"}}"#.to_string(), "phoneme_id_map"),
            (r#"{"audio": {"sample_rate": 22050}, "espeak": {"voice": "en-us"}, "phoneme_id_map": {}}"#.to_string(), "phoneme_id_map"),
        ] {
            let json: serde_json::Value = serde_json::from_str(&json).unwrap();
            let err = parse_voice_config(&json).unwrap_err();
            assert!(err.contains(needle), "expected `{needle}` in `{err}`");
        }
    }

    // ---- construction error paths (hermetic: no real model load) ----

    fn construction_err(model: &Path, espeak: &Path) -> SynthError {
        SherpaRunner::with_espeak_data(model, espeak)
            .err()
            .expect("construction must fail")
    }

    fn assert_voice_load(err: SynthError, needle: &str) {
        match err {
            SynthError::VoiceLoad { path, reason } => {
                assert!(reason.contains(needle), "expected `{needle}` in `{reason}`");
                assert!(!path.as_os_str().is_empty());
            }
            other => panic!("expected VoiceLoad, got {other:?}"),
        }
    }

    #[test]
    fn construction_fails_when_model_missing() {
        let dir = tempfile::tempdir().unwrap();
        let err = construction_err(&dir.path().join("nope.onnx"), dir.path());
        assert_voice_load(err, "does not exist");
    }

    #[test]
    fn construction_fails_when_json_sibling_missing() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("v.onnx");
        fs::write(&model, fake_onnx(&[])).unwrap();
        let err = construction_err(&model, dir.path());
        assert_voice_load(err, "sibling config");
    }

    #[test]
    fn construction_fails_when_espeak_data_missing() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("v.onnx");
        fs::write(&model, fake_onnx(&[])).unwrap();
        fs::write(dir.path().join("v.json"), full_config_json().to_string()).unwrap();
        let err = construction_err(&model, &dir.path().join("no-espeak"));
        assert_voice_load(err, "espeak-ng-data");
    }

    #[test]
    fn construction_fails_on_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("v.onnx");
        fs::write(&model, fake_onnx(&[])).unwrap();
        fs::write(dir.path().join("v.json"), "{not json").unwrap();
        let err = construction_err(&model, dir.path());
        assert_voice_load(err, "invalid config");
    }

    #[test]
    fn construction_fails_when_required_json_field_missing() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("v.onnx");
        fs::write(&model, fake_onnx(&[])).unwrap();
        fs::write(
            dir.path().join("v.json"),
            r#"{"espeak": {"voice": "en-us"}, "phoneme_id_map": {"a": [1]}}"#,
        )
        .unwrap();
        let err = construction_err(&model, dir.path());
        assert_voice_load(err, "audio.sample_rate");
    }

    #[test]
    fn construction_maps_runtime_rejection_to_voice_load() {
        // Valid-looking inputs but a garbage model: validation passes,
        // sherpa's create returns null → typed VoiceLoad, never a panic.
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("v.onnx");
        fs::write(&model, b"definitely not an onnx model").unwrap();
        fs::write(dir.path().join("v.json"), full_config_json().to_string()).unwrap();
        let err = construction_err(&model, dir.path());
        assert_voice_load(err, "rejected");
    }

    // ---- real-model e2e (needs a seeded voice + espeak-ng-data) ----

    const PARAGRAPH: &str = "The quick brown fox jumps over the lazy dog. TaleTrek turns \
        any ebook into an audiobook, entirely on this machine, with no cloud and no accounts.";

    #[test]
    #[ignore = "needs a real Piper voice + espeak-ng-data: TALETREK_VOICE_PATH (or the seeded cache voice) + TALETREK_ESPEAK_DATA (or ~/.cache/taletrek/espeak-ng-data); see docs/testing.md"]
    fn real_model_predicts_concat_wav_compatible_wav() {
        let Some(voice_model) = std::env::var_os("TALETREK_VOICE_PATH") else {
            eprintln!("skipped: TALETREK_VOICE_PATH not set (point it at a Piper .onnx with a sibling .json)");
            return;
        };
        let voice_model = PathBuf::from(voice_model);
        if !voice_model.is_file() {
            eprintln!(
                "skipped: TALETREK_VOICE_PATH `{}` does not exist",
                voice_model.display()
            );
            return;
        }
        let espeak = std::env::var_os("TALETREK_ESPEAK_DATA")
            .map(PathBuf::from)
            .or_else(default_espeak_data_dir);
        let Some(espeak) = espeak.filter(|p| p.is_dir()) else {
            eprintln!("skipped: no espeak-ng-data dir (set TALETREK_ESPEAK_DATA or seed ~/.cache/taletrek/espeak-ng-data)");
            return;
        };

        let mut runner = SherpaRunner::with_espeak_data(&voice_model, &espeak)
            .expect("seed-cache voice + espeak data must load");
        let wav = runner
            .predict(&voice_model, PARAGRAPH)
            .expect("one paragraph must synthesize");

        // Canonical WAV shape: RIFF/WAVE, PCM, mono, 16-bit, the model's rate.
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "16-bit");
        let rate = u32::from_le_bytes(wav[24..28].try_into().unwrap());
        assert_eq!(rate, 22_050, "hfc_female-medium sample rate");

        // concat_wav (the trait-level compatibility contract) splices it.
        let merged = crate::pcm::concat_wav(&[wav.clone(), wav.clone()]);
        let payload = wav.len() - 44;
        assert_eq!(merged.len(), 44 + 2 * payload);

        // Non-trivial duration with generous bounds (~9 s expected on this
        // paragraph per the T1 measurements; VITS noise makes it vary).
        let d1 = crate::pcm::wav_duration(&wav);
        assert!(d1 > 1.0 && d1 < 30.0, "duration out of bounds: {d1}s");

        // The loaded model is reused across predicts: a second call works and
        // lands within 50% of the first call's length (deterministic-ish).
        let wav2 = runner
            .predict(&voice_model, PARAGRAPH)
            .expect("second predict");
        let d2 = crate::pcm::wav_duration(&wav2);
        assert!(
            d2 > 1.0 && d2 < 30.0,
            "second duration out of bounds: {d2}s"
        );
        assert!(
            (d1 / d2 - 1.0).abs() < 0.5,
            "lengths diverged: {d1}s vs {d2}s"
        );
    }
}
