//! Synthesis pipeline integration: the trait seam (`FakeRunner` + `WavPassthrough`)
//! plus a `#[ignore]` end-to-end test against a real `piper` binary on `PATH`.
//!
//! The unit test proves the wiring contract:
//!   normalize → split → per-chunk `predict` → `concat_wav` → `encode`
//! and that the resulting cache key matches `cache_key(voice, original_text)`.

use std::path::{Path, PathBuf};

use taletrek_synth::{
    cache_key, synthesize_paragraph, AudioCodec, Encoder, OpusEncoder, PiperRunner,
    SubprocessPiperRunner, SynthError, SynthOptions, WavPassthrough,
};

/// Build a minimal canonical 44-byte-header mono/16-bit/16 kHz WAV whose PCM
/// payload is `pcm`. Used by `FakeRunner` to return *parseable* WAV bytes.
fn tiny_wav(pcm: &[u8]) -> Vec<u8> {
    let data_len = u32::try_from(pcm.len()).unwrap();
    let byte_rate = 32_000u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&16_000u32.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Test double for [`PiperRunner`]. Records every chunk it was asked to predict
/// and returns a distinct, parseable WAV per call so concat is observable.
struct FakeRunner {
    calls: Vec<String>,
}

impl PiperRunner for FakeRunner {
    fn predict(&mut self, _voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
        self.calls.push(text.to_string());
        let idx = u8::try_from(self.calls.len()).unwrap();
        let marker = 0x10u8.wrapping_add(idx);
        Ok(tiny_wav(&[marker, marker ^ 0xFF]))
    }
}

#[test]
fn synthesize_paragraph_normalizes_splits_concats_and_keys() {
    let mut runner = FakeRunner { calls: Vec::new() };
    let encoder = WavPassthrough;
    let voice_model = Path::new("/dev/null/voice.onnx");
    let voice = "en_US-lessac-medium";

    // Two long sentences (each well under the cap, together well over) so
    // split_for_speech yields >= 2 chunks. Embed a smart quote (U+2019) to
    // prove normalization ran before predict.
    let sentence_a = format!("O\u{2019}Reilly {}", "word ".repeat(80));
    let sentence_b = format!("Second {}", "item ".repeat(80));
    let text = format!("{sentence_a}. {sentence_b}.");

    let mut opts = SynthOptions::new(voice_model, &mut runner, &encoder);
    let out = synthesize_paragraph(voice, &text, &mut opts).expect("synth");

    // Cache key is derived from the ORIGINAL text (key normalizes internally),
    // preserving SPA parity.
    assert_eq!(out.cache_key, cache_key(voice, &text));

    // Encoder codec flows through.
    assert_eq!(out.codec, AudioCodec::Wav);

    // Normalization ran: no smart quote reached predict.
    let recorded = &runner.calls;
    assert!(
        recorded.iter().all(|c| !c.contains('\u{2019}')),
        "normalize should have stripped U+2019 before predict; got {recorded:?}"
    );

    // Splitting ran: long input was chunked.
    let n = runner.calls.len();
    assert!(n >= 2, "expected >= 2 chunks, got {n}");

    // Concat ran: output is a WAV whose data section holds every chunk's
    // payload, in order, with no header duplication.
    let header_len = 44usize;
    assert_eq!(
        out.audio.len(),
        header_len + 2 * n,
        "concatenated WAV should be one 44-byte header + 2 payload bytes per chunk"
    );
    for (i, chunk) in runner.calls.iter().enumerate() {
        let _ = chunk;
        let marker = 0x10u8.wrapping_add((i + 1) as u8);
        let off = header_len + 2 * i;
        assert_eq!(&out.audio[off..off + 2], &[marker, marker ^ 0xFF]);
    }

    // Duration parsed from the concatenated WAV: payload is 2 bytes/chunk,
    // 16-bit mono → 1 sample/chunk; at 16 kHz, n samples → n/16000 s.
    assert!(out.duration_seconds > 0.0);
    let expected = n as f64 / 16_000.0;
    assert!(
        (out.duration_seconds - expected).abs() < 1e-6,
        "duration {} should be {expected}",
        out.duration_seconds
    );
}

#[test]
fn synthesize_paragraph_short_text_is_single_chunk() {
    let mut runner = FakeRunner { calls: Vec::new() };
    let encoder = WavPassthrough;
    let mut opts = SynthOptions::new(Path::new("/dev/null/voice.onnx"), &mut runner, &encoder);
    let out = synthesize_paragraph("v", "Hello world.", &mut opts).expect("synth");
    assert_eq!(runner.calls.len(), 1);
    assert_eq!(runner.calls[0], "Hello world.");
    assert_eq!(out.cache_key, cache_key("v", "Hello world."));
}

#[test]
fn synthesize_paragraph_empty_text_errors() {
    let mut runner = FakeRunner { calls: Vec::new() };
    let encoder = WavPassthrough;
    let mut opts = SynthOptions::new(Path::new("/dev/null/voice.onnx"), &mut runner, &encoder);
    let err = synthesize_paragraph("v", "   ", &mut opts).unwrap_err();
    assert!(matches!(err, SynthError::EmptyText), "got {err:?}");
}

#[test]
fn opus_encoder_is_selected_when_used() {
    // Sanity: OpusEncoder reports the Opus codec without running ffmpeg (codec()
    // is a pure accessor). Encoding itself is exercised only by the ignored
    // real-piper test below.
    let enc = OpusEncoder::new();
    assert_eq!(enc.codec(), AudioCodec::Opus);
}

/// End-to-end against a real `piper` binary + real Opus encode via ffmpeg.
///
/// Skipped unless BOTH `TALETREK_PIPER_MODEL` points at a `.onnx` voice model
/// AND the `piper` binary resolves (via `TALETREK_PIPER_BIN` or `PATH`).
#[test]
#[ignore = "requires piper + ffmpeg on PATH and TALETREK_PIPER_MODEL; see task T1.7"]
fn real_piper_synthesizes_opus() {
    let bin = std::env::var_os("TALETREK_PIPER_BIN").unwrap_or_else(|| "piper".into());
    if std::process::Command::new(&bin)
        .arg("--help")
        .output()
        .is_err()
    {
        eprintln!("skipped: `{bin:?}` binary not found");
        return;
    }
    let model = match std::env::var("TALETREK_PIPER_MODEL") {
        Ok(m) => PathBuf::from(m),
        Err(_) => {
            eprintln!("skipped: TALETREK_PIPER_MODEL not set");
            return;
        }
    };

    let mut runner = SubprocessPiperRunner::new(bin);
    let encoder = OpusEncoder::new();
    let mut opts = SynthOptions::new(&model, &mut runner, &encoder);
    let out = synthesize_paragraph("en_US-lessac-medium", "Hello world.", &mut opts)
        .expect("real piper synth");

    assert_eq!(out.codec, AudioCodec::Opus);
    assert!(!out.audio.is_empty());
    assert!(out.duration_seconds > 0.0);
    assert_eq!(
        out.cache_key,
        cache_key("en_US-lessac-medium", "Hello world.")
    );
}
