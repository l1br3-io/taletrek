//! Engine-parity e2e (desktop-synth-gui T5): the same fixture text synth'd
//! through **both** engines — the in-process default (sherpa-onnx runner +
//! vendored libopus encoder, no engine flags) and the subprocess overrides
//! (`--piper` + `--ffmpeg`) — must produce bundles with **identical
//! cache-key sets**. That parity is the interchange invariant: cache keys are
//! content-addressed from voice + normalized text, never from the engine, so
//! audio dedups across engines and apps.
//!
//! `#[ignore]`d like `synth_e2e.rs`; it soft-skips unless ALL of:
//! - `piper` resolves on `PATH` (or `TALETREK_PIPER_BIN`),
//! - `ffmpeg` resolves on `PATH` (or `TALETREK_FFMPEG_BIN`),
//! - `TALETREK_VOICE_PATH` points at a `.onnx` with its sibling `.json`, and
//! - espeak-ng-data exists (at `$TALETREK_ESPEAK_DATA`, else the default
//!   `<cache>/taletrek/espeak-ng-data` the `just setup` seeds).
//!
//! Run via `just test-e2e` (pre-wired) or:
//! `cargo test -p taletrek-desktop --test engine_parity -- --ignored --nocapture`.
//! Compiling the native side needs the desktop default features (`sherpa` +
//! `native-encode`), which the plain `cargo test` profile carries.

#![cfg(feature = "sherpa")]

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;

use taletrek_synth::{
    write_book_bundle, AudioCodec, AudioMeta, BookBundle, BookMeta, ChapterText, Generator,
    Manifest, ManifestKind, NORM_VERSION,
};

/// Absolute path to the `taletrek-desktop` binary under test.
const BIN: &str = env!("CARGO_BIN_EXE_taletrek-desktop");

/// OGG container magic — every Opus segment (either encoder) starts with it.
const OGG_MAGIC: &[u8] = b"OggS";

/// Resolve a binary path: `TALETREK_<NAME>_BIN` env override, else `name` on
/// `PATH`.
fn resolve_bin(env_var: &str, default: &str) -> String {
    std::env::var(env_var).unwrap_or_else(|_| default.to_string())
}

/// Probe whether a binary exists + runs (`--help` / `-version`).
fn binary_runs(bin: &str, probe_args: &[&str]) -> Option<String> {
    Command::new(bin)
        .args(probe_args)
        .output()
        .ok()
        .filter(|o| o.status.success() || !o.stderr.is_empty())
        .map(|_| bin.to_string())
}

/// The gate mirroring `synth_e2e.rs`, plus the espeak-ng-data check the
/// native engine needs. Returns `(piper, ffmpeg, voice_model, espeak_data)`.
fn gate() -> Option<(String, String, PathBuf, PathBuf)> {
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
    if !voice_model.is_file() || !voice_model.with_extension("json").is_file() {
        eprintln!(
            "skipped: TALETREK_VOICE_PATH `{}` (or its .json sibling) missing",
            voice_model.display()
        );
        return None;
    }

    let espeak = std::env::var_os("TALETREK_ESPEAK_DATA")
        .map(PathBuf::from)
        .or_else(taletrek_synth::default_espeak_data_dir);
    let Some(espeak) = espeak.filter(|p| p.is_dir()) else {
        eprintln!(
            "skipped: no espeak-ng-data dir (set TALETREK_ESPEAK_DATA or seed the default cache)"
        );
        return None;
    };

    Some((piper, ffmpeg, voice_model, espeak))
}

/// Write the text-only fixture (3 distinct paragraphs across 2 chapters —
/// same shape as `synth_e2e.rs`) at `path`.
fn write_text_only_fixture(path: &Path) {
    let chapters = vec![
        ChapterText::new(
            "bk_parity",
            0,
            "Chapter One",
            vec![
                "The quick brown fox jumps over the lazy dog.".into(),
                "Pack my box with five dozen liquor jugs.".into(),
            ],
        ),
        ChapterText::new(
            "bk_parity",
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
                id: "bk_parity".into(),
                title: "Parity Fixture".into(),
                author: None,
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
    write_book_bundle(&bundle, &mut buf).expect("fixture write");
    fs::write(path, buf.into_inner()).expect("fixture file write");
}

/// Run the binary with `subcommand` + `args`; assert a clean exit (stderr is
/// shown on failure for diagnostics).
fn run_desktop(subcommand: &str, args: &[&str], env: &[(&str, &std::ffi::OsStr)]) {
    let mut cmd = Command::new(BIN);
    cmd.arg(subcommand).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let output = cmd
        .output()
        .unwrap_or_else(|e| panic!("spawn `{BIN}`: {e}"));
    assert!(
        output.status.success(),
        "`{BIN} {subcommand}` exited {:?}\n--- stderr ---\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The parity invariant: same text through both engines → identical
/// cache-key sets, both bundles loadable, both Opus. Proves (a) the CLI
/// default runs the in-process engines with zero external binaries wired, and
/// (b) `--piper`/`--ffmpeg` still select the subprocess engines.
#[test]
#[ignore = "requires piper + ffmpeg + TALETREK_VOICE_PATH + espeak-ng-data; see docs/testing.md (just test-e2e pre-wires all)"]
fn both_engines_produce_identical_cache_key_sets() {
    let Some((piper, ffmpeg, voice_model, espeak)) = gate() else {
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let input = dir.path().join("book.taletrek");
    write_text_only_fixture(&input);

    // Run 1 — the default: NO engine flags. The in-process sherpa runner +
    // native Opus encoder must engage (espeak override wired via env to keep
    // the run hermetic to the gate's seeded data).
    let native_out = dir.path().join("native.synth.taletrek");
    run_desktop(
        "synth",
        &[
            "--input",
            &input.display().to_string(),
            "--voice-path",
            &voice_model.display().to_string(),
            "--output",
            &native_out.display().to_string(),
            "--jobs",
            "1",
        ],
        &[("TALETREK_ESPEAK_DATA", espeak.as_os_str())],
    );

    // Run 2 — explicit subprocess overrides: piper runner + ffmpeg encoder.
    let sub_out = dir.path().join("subprocess.synth.taletrek");
    run_desktop(
        "synth",
        &[
            "--input",
            &input.display().to_string(),
            "--voice-path",
            &voice_model.display().to_string(),
            "--output",
            &sub_out.display().to_string(),
            "--jobs",
            "1",
            "--piper",
            &piper,
            "--ffmpeg",
            &ffmpeg,
        ],
        &[],
    );

    // Both bundles load via read_book_bundle and are full Opus.
    let load = |path: &Path| -> BookBundle {
        let bytes = fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let b = taletrek_synth::read_book_bundle(&bytes)
            .unwrap_or_else(|e| panic!("load {}: {e}", path.display()));
        assert!(
            b.manifest.audio.present,
            "{}: audio present",
            path.display()
        );
        assert_eq!(b.manifest.audio.codec, AudioCodec::Opus);
        assert_eq!(b.manifest.audio.segment_count, 3, "3 distinct paragraphs");
        assert_eq!(b.audio.len(), 3);
        for seg in b.audio.values() {
            assert_eq!(seg.codec, AudioCodec::Opus);
            assert!(
                seg.bytes.starts_with(OGG_MAGIC),
                "{}: segment is a real OGG/Opus stream",
                path.display()
            );
        }
        b
    };
    let native = load(&native_out);
    let subprocess = load(&sub_out);

    // The parity invariant: identical cache-key sets regardless of engine.
    let native_keys: Vec<&String> = native.audio.keys().collect();
    let sub_keys: Vec<&String> = subprocess.audio.keys().collect();
    assert_eq!(
        native_keys
            .iter()
            .collect::<std::collections::BTreeSet<_>>(),
        sub_keys.iter().collect::<std::collections::BTreeSet<_>>(),
        "same text ⇒ same cache keys regardless of engine"
    );

    // Both manifests name the same voice (keys are namespaced by it).
    assert_eq!(
        native.manifest.book.voice_id,
        subprocess.manifest.book.voice_id
    );
}
