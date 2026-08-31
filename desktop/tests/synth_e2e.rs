//! End-to-end integration for `taletrek-desktop`: a real `piper` + real
//! `ffmpeg` + real Piper voice model turn a text-only `.taletrek` fixture into
//! a full Opus bundle — plus (kernel-parse T11) the parse→synth two-step and
//! the chained `synth --input <source>` one-command path over a TXT source.
//!
//! Both tests are `#[ignore]`d and gated exactly like effort 1's
//! `real_piper_synthesizes_opus` (`crates/synth/tests/synth_integration.rs`):
//! they soft-skip (print `skipped: …` and return) unless ALL of:
//! - `piper` resolves on `PATH` (or via `TALETREK_PIPER_BIN`), and
//! - `ffmpeg` resolves on `PATH` (or via `TALETREK_FFMPEG_BIN`), and
//! - `TALETREK_VOICE_PATH` points at a `.onnx` whose sibling `<stem>.json`
//!   exists (the offline escape hatch — point it at any curated voice you've
//!   pre-downloaded, e.g. `~/.cache/taletrek/voices/en_US-hfc_female-medium.onnx`).
//!
//! Run with: `cargo test -p taletrek-desktop --test synth_e2e -- --ignored`
//! after exporting those three env vars. The unit tests in `src/` cover the
//! full wiring with stub runners; this file proves the real binary, invoked
//! as a subprocess, produces a bundle whose Opus audio actually plays.
//!
//! See `docs/specs/desktop-synth-app/runbook.md` for the human smoke test
//! (audio-plays check that a test can't assert).

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;

use taletrek_synth::{
    write_book_bundle, AudioCodec, AudioMeta, BookBundle, BookMeta, ChapterText, Generator,
    Manifest, ManifestKind, NORM_VERSION,
};

/// Absolute path to the `taletrek-desktop` binary under test. Cargo sets this
/// at compile time when building integration tests for a `[[bin]]` crate.
const BIN: &str = env!("CARGO_BIN_EXE_taletrek-desktop");

/// OGG container magic — every Opus segment `ffmpeg -c:a libopus` emits starts
/// with these four bytes. Stronger than "non-empty": it proves real ffmpeg ran
/// and produced a parseable OGG/Opus stream.
const OGG_MAGIC: &[u8] = b"OggS";

/// Resolve a binary path: `TALETREK_<NAME>_BIN` env override, else `name` on
/// `PATH`. Returns the string the CLI should receive as `--<flag> <value>`.
fn resolve_bin(env_var: &str, default: &str) -> String {
    std::env::var(env_var).unwrap_or_else(|_| default.to_string())
}

/// Probe whether a binary exists + runs by invoking `<bin> --help` (piper) or
/// `<bin> -version` (ffmpeg). Returns `Some(bin)` if it runs, `None` otherwise.
/// Used by the gate to soft-skip when native deps aren't installed.
fn binary_runs(bin: &str, probe_args: &[&str]) -> Option<String> {
    Command::new(bin)
        .args(probe_args)
        .output()
        .ok()
        .filter(|o| o.status.success() || !o.stderr.is_empty())
        .map(|_| bin.to_string())
}

/// The shared gate: soft-skip the test unless piper, ffmpeg, and a voice model
/// are all available. Prints a `skipped:` line per missing prerequisite so the
/// reason is visible under `--nocapture`. Returns the resolved `(piper, ffmpeg,
/// voice_model)` triple when every prerequisite is present.
fn gate() -> Option<(String, String, PathBuf)> {
    let piper = resolve_bin("TALETREK_PIPER_BIN", "piper");
    let piper = binary_runs(&piper, &["--help"]).or_else(|| {
        eprintln!("skipped: `{piper}` binary not found (set TALETREK_PIPER_BIN or add to PATH)");
        None
    })?;

    let ffmpeg = resolve_bin("TALETREK_FFMPEG_BIN", "ffmpeg");
    let ffmpeg = binary_runs(&ffmpeg, &["-version"]).or_else(|| {
        eprintln!("skipped: `{ffmpeg}` binary not found (set TALETREK_FFMPEG_BIN or add to PATH)");
        None
    })?;

    let voice_model = match std::env::var_os("TALETREK_VOICE_PATH") {
        Some(p) => PathBuf::from(p),
        None => {
            eprintln!("skipped: TALETREK_VOICE_PATH not set (point it at a Piper .onnx with a sibling .json)");
            return None;
        }
    };
    if !voice_model.is_file() {
        eprintln!(
            "skipped: TALETREK_VOICE_PATH `{}` does not exist",
            voice_model.display()
        );
        return None;
    }
    let json_sibling = voice_model.with_extension("json");
    if !json_sibling.is_file() {
        eprintln!(
            "skipped: TALETREK_VOICE_PATH `{}` has no sibling `{}`",
            voice_model.display(),
            json_sibling.display()
        );
        return None;
    }
    Some((piper, ffmpeg, voice_model))
}

/// Build a minimal text-only `.taletrek` fixture at `path` with three distinct
/// paragraphs across two chapters. Distinct text → three segments after synth
/// (content addressing dedups identical paragraphs; we want the count exact).
fn write_text_only_fixture(path: &Path) -> BookBundle {
    let chapters = vec![
        ChapterText::new(
            "bk_e2e",
            0,
            "Chapter One",
            vec![
                "The quick brown fox jumps over the lazy dog.".into(),
                "Pack my box with five dozen liquor jugs.".into(),
            ],
        ),
        ChapterText::new(
            "bk_e2e",
            1,
            "Chapter Two",
            vec!["Sphinx of black quartz, judge my vow.".into()],
        ),
    ];
    let chapter_count = u32::try_from(chapters.len()).unwrap();
    let bundle = BookBundle {
        manifest: Manifest {
            schema_version: 1,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_e2e".into(),
                title: "E2E Fixture".into(),
                author: Some("TaleTrek".into()),
                source_format: "txt".into(),
                chapter_count,
                voice_id: "en_US-hfc_female-medium".into(),
                created_at: 0,
                updated_at: 0,
                progress_fraction: None,
            },
            audio: AudioMeta {
                present: false,
                codec: AudioCodec::Opus,
                norm_version: NORM_VERSION.parse().unwrap(),
                segment_count: 0,
            },
            generator: Generator {
                app: "taletrek-desktop-test".into(),
                version: "0.0.0".into(),
            },
        },
        chapters,
        audio: HashMap::new(),
    };
    let mut buf = Cursor::new(Vec::new());
    write_book_bundle(&bundle, &mut buf).expect("write_book_bundle succeeds for fixture");
    fs::write(path, buf.into_inner()).expect("fixture write succeeds");
    bundle
}

/// Build CLI args shared by both subcommands (everything except the subcommand
/// name + `--voice`). `--jobs 1` keeps the run deterministic + light (one
/// piper model loaded at a time).
fn common_args(
    input: &Path,
    output: &Path,
    voice_model: &Path,
    piper: &str,
    ffmpeg: &str,
) -> Vec<String> {
    vec![
        "--input".into(),
        input.display().to_string(),
        "--voice-path".into(),
        voice_model.display().to_string(),
        "--output".into(),
        output.display().to_string(),
        "--jobs".into(),
        "1".into(),
        "--piper".into(),
        piper.into(),
        "--ffmpeg".into(),
        ffmpeg.into(),
    ]
}

/// Spawn `taletrek-desktop <subcommand> <args>`, capture stdout+stderr, and
/// assert a clean exit. Returns the captured output for failure diagnostics.
fn run_desktop(subcommand: &str, args: &[String]) {
    let output = Command::new(BIN)
        .arg(subcommand)
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("failed to spawn `{BIN} {subcommand}`: {e}"));
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!(
            "`{BIN} {subcommand}` exited {:?}\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}",
            output.status.code()
        );
    }
}

/// End-to-end: `taletrek-desktop synth` on a text-only fixture produces a full
/// Opus bundle. Verifies the binary's full pipeline — CLI parse → voice
/// resolution (`--voice-path` offline path) → parallel synth → manifest stamp
/// → bundle write — and that every audio segment is a real OGG/Opus stream.
#[test]
#[ignore = "requires piper + ffmpeg on PATH and TALETREK_VOICE_PATH; see docs/specs/desktop-synth-app/runbook.md"]
fn real_synth_produces_full_opus_bundle() {
    let Some((piper, ffmpeg, voice_model)) = gate() else {
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir for e2e");
    let input = dir.path().join("book.taletrek");
    let output = dir.path().join("book.synth.taletrek");
    let fixture = write_text_only_fixture(&input);
    let voice_id = fixture.manifest.book.voice_id.clone();

    run_desktop(
        "synth",
        &common_args(&input, &output, &voice_model, &piper, &ffmpeg),
    );

    assert!(
        output.is_file(),
        "output bundle must exist at {}",
        output.display()
    );
    let bytes = fs::read(&output).expect("read output bundle");
    assert!(!bytes.is_empty(), "output bundle must be non-empty");
    let bundle = taletrek_synth::read_book_bundle(&bytes).expect("round-trip read_book_bundle");

    // Manifest flipped to "full" with the Opus codec, current norm version,
    // and the taletrek-desktop generator at the running crate version.
    assert!(bundle.manifest.audio.present, "audio.present must be true");
    assert_eq!(bundle.manifest.audio.codec, AudioCodec::Opus);
    assert_eq!(
        bundle.manifest.audio.norm_version,
        NORM_VERSION.parse::<u32>().unwrap()
    );
    assert_eq!(bundle.manifest.generator.app, "taletrek-desktop");
    assert_eq!(bundle.manifest.generator.version, env!("CARGO_PKG_VERSION"));

    // Three distinct paragraphs → three segments, content-addressed.
    let expected_count = 3u32;
    assert_eq!(bundle.manifest.audio.segment_count, expected_count);
    assert_eq!(bundle.audio.len(), usize::try_from(expected_count).unwrap());

    // book.voiceId names the voice the segments are keyed under (the fixture's
    // manifest already carried the default voice, and no --voice was passed,
    // so the rewrite is a no-op here — the unit suite pins the differing-voice
    // case).
    assert_eq!(bundle.manifest.book.voice_id, voice_id);

    // Every segment carries its key + non-empty OGG/Opus bytes (proves real
    // piper + real ffmpeg ran, not just that the map is populated).
    for (key, seg) in &bundle.audio {
        assert_eq!(seg.key, *key, "segment key must match map key");
        assert_eq!(seg.codec, AudioCodec::Opus, "segment codec must be Opus");
        assert!(
            seg.bytes.starts_with(OGG_MAGIC),
            "segment `{key}` must start with OGG magic `OggS`; got first 4 bytes {:?}",
            &seg.bytes[..seg.bytes.len().min(4)]
        );
    }
}

/// End-to-end: `taletrek-desktop resynth` accepts the full bundle from
/// [`real_synth_produces_full_opus_bundle`] and re-voices it under a different
/// voice id (same `--voice-path` model). Proves the full round-trip — full
/// bundle in → re-keyed full bundle out — and that resynth's manifest rewrite
/// surfaces in the on-disk file.
#[test]
#[ignore = "requires piper + ffmpeg on PATH and TALETREK_VOICE_PATH; see docs/specs/desktop-synth-app/runbook.md"]
fn real_resynth_revoices_full_bundle() {
    let Some((piper, ffmpeg, voice_model)) = gate() else {
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir for e2e");
    let input = dir.path().join("book.taletrek");
    let synth_out = dir.path().join("book.synth.taletrek");
    let resynth_out = dir.path().join("book.resynth.taletrek");
    let _ = write_text_only_fixture(&input);

    // First synth to get a full bundle.
    run_desktop(
        "synth",
        &common_args(&input, &synth_out, &voice_model, &piper, &ffmpeg),
    );

    // Then resynth under a different voice id (same --voice-path model).
    let new_voice = "en_US-ryan-medium";
    let mut args = common_args(&synth_out, &resynth_out, &voice_model, &piper, &ffmpeg);
    args.insert(0, new_voice.into());
    args.insert(0, "--voice".into());
    run_desktop("resynth", &args);

    assert!(resynth_out.is_file(), "resynth output must exist");
    let bytes = fs::read(&resynth_out).expect("read resynth output");
    let bundle = taletrek_synth::read_book_bundle(&bytes).expect("read resynth bundle");

    // Manifest voice flipped to the new voice (resynth rewrites book.voiceId).
    assert_eq!(bundle.manifest.book.voice_id, new_voice);
    assert!(bundle.manifest.audio.present);
    assert_eq!(bundle.manifest.audio.codec, AudioCodec::Opus);

    // Every segment is keyed under the new voice + is real OGG/Opus.
    assert_eq!(bundle.audio.len(), 3);
    for seg in bundle.audio.values() {
        assert_eq!(seg.codec, AudioCodec::Opus);
        assert!(
            seg.bytes.starts_with(OGG_MAGIC),
            "resynth segment must start with OGG magic"
        );
    }
}

/// Write a small TXT source fixture at `path`: two `Chapter …` heading lines
/// → two chapters, each with one distinct paragraph → exactly 2 content-
/// addressed segments after synth.
fn write_txt_source(path: &Path) {
    fs::write(
        path,
        "Chapter One\n\nThe quick brown fox jumps over the lazy dog.\n\nChapter Two\n\nPack my box with five dozen liquor jugs.",
    )
    .expect("txt source write succeeds");
}

/// Assert the full-audio invariants every kernel-parse e2e run must hold:
/// manifest flipped to full Opus at the current norm version, desktop
/// generator stamped, `expected_segments` content-addressed segments, and
/// every segment a real OGG/Opus stream (proves piper + ffmpeg both ran).
fn assert_full_opus_bundle(bundle: &BookBundle, expected_segments: u32) {
    assert!(bundle.manifest.audio.present, "audio.present must be true");
    assert_eq!(bundle.manifest.audio.codec, AudioCodec::Opus);
    assert_eq!(
        bundle.manifest.audio.norm_version,
        NORM_VERSION.parse::<u32>().unwrap()
    );
    assert_eq!(bundle.manifest.generator.app, "taletrek-desktop");
    assert_eq!(bundle.manifest.audio.segment_count, expected_segments);
    assert_eq!(
        bundle.audio.len(),
        usize::try_from(expected_segments).unwrap()
    );
    assert!(!bundle.audio.is_empty(), "segments must exist");
    for (key, seg) in &bundle.audio {
        assert_eq!(seg.key, *key, "segment key must match map key");
        assert_eq!(seg.codec, AudioCodec::Opus);
        assert!(
            seg.bytes.starts_with(OGG_MAGIC),
            "segment `{key}` must start with OGG magic `OggS`; got first 4 bytes {:?}",
            &seg.bytes[..seg.bytes.len().min(4)]
        );
    }
}

/// End-to-end (kernel-parse T11): the two-step path through the parse crate —
/// `parse` a TXT source into a text-only bundle, then `synth` that bundle.
/// Proves the artifacts the chained path is measured against: both commands
/// exit clean and the final bundle is full Opus audio.
#[test]
#[ignore = "requires piper + ffmpeg on PATH and TALETREK_VOICE_PATH; see docs/specs/desktop-synth-app/runbook.md"]
fn parse_then_synth_txt_two_step_produces_full_opus_bundle() {
    let Some((piper, ffmpeg, voice_model)) = gate() else {
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir for e2e");
    let src = dir.path().join("fable.txt");
    write_txt_source(&src);

    // Step 1: parse → default output beside the input (<stem>.taletrek).
    run_desktop("parse", &["--input".into(), src.display().to_string()]);
    let text_only = dir.path().join("fable.taletrek");
    assert!(
        text_only.is_file(),
        "parse default output must exist at {}",
        text_only.display()
    );
    let pre = taletrek_synth::read_book_bundle(&fs::read(&text_only).unwrap()).unwrap();
    assert!(!pre.manifest.audio.present, "parse output is text-only");

    // Step 2: synth the produced bundle → full audio bundle.
    let full = dir.path().join("fable.synth.taletrek");
    run_desktop(
        "synth",
        &common_args(&text_only, &full, &voice_model, &piper, &ffmpeg),
    );
    let bundle = taletrek_synth::read_book_bundle(&fs::read(&full).unwrap()).unwrap();
    assert_full_opus_bundle(&bundle, 2);
    assert_eq!(bundle.manifest.book.source_format, "txt");
    assert_eq!(
        bundle.manifest.book.chapter_count, 2,
        "txt chapter split ran"
    );
}

/// End-to-end (kernel-parse T11): the chained one-command path — `synth
/// --input fable.txt` parses the source in memory and synthesizes it in one
/// invocation. Proves the chain needs no intermediate bundle on disk and that
/// the default output follows the unchanged naming rule (`<stem>.synth.taletrek`).
#[test]
#[ignore = "requires piper + ffmpeg on PATH and TALETREK_VOICE_PATH; see docs/specs/desktop-synth-app/runbook.md"]
fn chained_synth_on_txt_source_produces_full_opus_bundle() {
    let Some((piper, ffmpeg, voice_model)) = gate() else {
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir for e2e");
    let src = dir.path().join("fable.txt");
    write_txt_source(&src);

    // One command, no --output: the default must land beside the source as
    // <stem>.synth.taletrek.
    run_desktop(
        "synth",
        &[
            "--input".into(),
            src.display().to_string(),
            "--voice-path".into(),
            voice_model.display().to_string(),
            "--jobs".into(),
            "1".into(),
            "--piper".into(),
            piper.clone(),
            "--ffmpeg".into(),
            ffmpeg.clone(),
        ],
    );
    let output = dir.path().join("fable.synth.taletrek");
    assert!(
        output.is_file(),
        "chained default output must exist at {}",
        output.display()
    );
    assert!(
        !dir.path().join("fable.taletrek").exists(),
        "the chain is in memory — no intermediate text-only bundle on disk"
    );

    let bundle = taletrek_synth::read_book_bundle(&fs::read(&output).unwrap()).unwrap();
    assert_full_opus_bundle(&bundle, 2);
    assert_eq!(bundle.manifest.book.source_format, "txt");
    assert_eq!(
        bundle.manifest.book.chapter_count, 2,
        "txt chapter split ran"
    );
}
