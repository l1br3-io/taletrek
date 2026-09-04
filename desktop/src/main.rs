//! Entry point for `taletrek-desktop`.
//!
//! Bare invocation (or `gui`) opens the eframe window (desktop-synth-gui
//! T7): pick files → queue → convert (parse → in-process synth → bundle
//! write) with live progress. The `parse`/`synth`/`resynth` subcommands are
//! the headless CLI, unchanged.
//!
//! Phase 6 (T2.6) wires a `Progress` sink (stderr behind a `Write` seam)
//! through both subcommands: download progress during voice resolution,
//! `synth [n/total] pct%` per paragraph, and a final `kind: N segments, voice
//! V, Mm Ss → out` summary line. `synth` was wired in Phase 4 (T2.4);
//! `resynth` in Phase 5 (T2.5).
//!
//! Effort 4 / T1: voice acquisition + progress reporting moved into the shared
//! `taletrek-worker` crate; this binary imports them. Behavior is identical.
//!
//! desktop-synth-gui / T5: engine selection lives in [`engine`] — the default
//! is in-process (sherpa-onnx runner + vendored libopus encoder, no external
//! binaries); `--piper`/`--ffmpeg` demote either side back to the subprocess
//! engines independently.

mod bundle_io;
mod cli;
mod engine;
mod gui;

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use clap::Parser;

use taletrek_parse::SourceFormat;
use taletrek_synth::synth::PiperRunner;
use taletrek_synth::{read_book_bundle, BookBundle};
use taletrek_worker::{
    default_cache_dir, resolve_voice, Progress, ResolveOpts, UreqVoiceSource, DEFAULT_VOICE_ID,
};

use crate::bundle_io::{
    default_parse_output, default_resynth_output, default_synth_output, desktop_generator,
    refuse_full_input, resynth_and_stamp, synth_and_stamp, write_book_bundle_file,
};
use crate::cli::{Cli, Cmd, CommonArgs, ParseArgs};
use crate::engine::{effective_jobs, DesktopEncoder, DesktopRunner, RunnerSpec};

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        None | Some(Cmd::Gui) => gui::run(),
        Some(Cmd::Parse { args }) => run_parse(args),
        Some(Cmd::Synth { common }) => run_synth(common),
        Some(Cmd::Resynth { common }) => run_resynth(common),
    }
}

/// `parse` subcommand handler — the CLI's front door for source documents.
///
/// All filesystem contact for the parse path lives here (the parse crate is
/// pure): read the source bytes, map the extension to a [`SourceFormat`],
/// parse + clean via the kernel, wrap into a text-only bundle stamped with the
/// desktop generator identity, and write it beside the input (or to
/// `--output`). No synth, no voice resolution — the bundle is ready for
/// `synth` (or the chain, T11).
fn run_parse(args: ParseArgs) -> Result<()> {
    // Extension check first: an unsupported format is a user error worth
    // naming before any filesystem complaint.
    let format = source_format_for_extension(&args.input)?;
    let input_bytes = fs::read(&args.input)
        .with_context(|| format!("reading source document {}", args.input.display()))?;
    let hint = args
        .input
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned);

    let book = taletrek_parse::parse_source(&input_bytes, format, hint.as_deref())?;
    let bundle = taletrek_parse::to_text_only_bundle(&book, &args.voice, desktop_generator());

    let output = args
        .output
        .clone()
        .unwrap_or_else(|| default_parse_output(&args.input));
    write_book_bundle_file(&bundle, &output)
        .with_context(|| format!("writing output bundle {}", output.display()))?;
    eprintln!(
        "parse: {} ({} chapters, {}) → {}",
        bundle.manifest.book.title,
        bundle.chapters.len(),
        args.voice,
        output.display()
    );
    Ok(())
}

/// Map an input path's extension to a [`SourceFormat`] for `parse`.
/// Case-insensitive; extensionless paths are unsupported too.
fn source_format_for_extension(
    path: &std::path::Path,
) -> Result<SourceFormat, UnsupportedExtensionError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("epub") => Ok(SourceFormat::Epub),
        Some("txt") => Ok(SourceFormat::Txt),
        Some("html" | "htm") => Ok(SourceFormat::Html),
        Some("md" | "markdown") => Ok(SourceFormat::Md),
        Some("docx") => Ok(SourceFormat::Docx),
        Some("pdf") => Ok(SourceFormat::Pdf),
        _ => Err(UnsupportedExtensionError {
            path: path.to_path_buf(),
        }),
    }
}

/// The input's extension doesn't map to a parseable source format (or the
/// path has none). Lists what `parse` accepts so the error is actionable.
#[derive(Debug, thiserror::Error)]
#[error(
    "unsupported input format: {path} — parse accepts .epub, .txt, .html, .htm, .md, .markdown, .docx, .pdf"
)]
pub struct UnsupportedExtensionError {
    /// The input path that carried the unsupported (or missing) extension.
    path: std::path::PathBuf,
}

/// `synth` subcommand handler.
///
/// Loads a text-only bundle (or parses a source document in memory — the
/// chained one-command path), refuses an already-full input (pointing the user
/// at `resynth`), resolves the voice (curated download or `--voice-path`),
/// synthesizes every paragraph in parallel, stamps the manifest, and writes the
/// result beside the input (or to `--output`). Progress flows to stderr
/// throughout: voice-download bytes, per-paragraph synth count, and a final
/// summary.
///
/// Engines (T5): the in-process sherpa runner + native Opus encoder by
/// default; `--piper`/`--ffmpeg` demote either side to the subprocess engines
/// independently. The native default runs 2 jobs (per-model memory); the
/// subprocess default uses the CPU count. Explicit `--jobs` always wins.
fn run_synth(common: CommonArgs) -> Result<()> {
    let progress = Progress::to_stderr();
    let runner_spec = RunnerSpec::select(common.piper.as_deref())?;
    let encoder = DesktopEncoder::select(common.ffmpeg.as_deref())?;
    let jobs = effective_jobs(common.jobs, &runner_spec);
    run_synth_with(
        common,
        Some(&progress),
        move |voice_model| DesktopRunner::new(runner_spec.clone(), voice_model),
        &encoder,
        jobs,
    )
}

/// The injectable core of `run_synth`: everything after CLI parsing + engine
/// selection, with the synth runner factory + encoder and progress as seams so
/// unit tests drive the full pipeline — input dispatch included — with
/// in-process stubs. The factory receives the resolved voice-model path (the
/// native engine constructs from it; the subprocess engine ignores it).
///
/// The input dispatch ([`load_synth_input`]) runs first, before voice
/// resolution, so a bad input path or unsupported source extension fails fast
/// without touching the network or spawning anything.
fn run_synth_with<R, E, F>(
    common: CommonArgs,
    progress: Option<&Progress>,
    make_runner_of: F,
    encoder: &E,
    jobs: usize,
) -> Result<()>
where
    R: PiperRunner + Send,
    E: taletrek_synth::Encoder + Sync,
    F: Fn(&Path) -> R + Sync,
{
    let voice_id = common
        .voice
        .clone()
        .unwrap_or_else(|| DEFAULT_VOICE_ID.to_string());

    // Load + guard: synth only accepts text-only bundles (a chained source
    // is parsed into a fresh one, so the guard is trivially satisfied there).
    let mut bundle = load_synth_input(&common.input, &voice_id)?;
    refuse_full_input(&bundle, &common.input)?;

    // Resolve the voice model: curated id (cache or download) or --voice-path.
    let cache_dir = default_cache_dir().context(
        "no platform cache directory discovered (set $HOME or pass --voice-path to use a local model)",
    )?;
    let opts = ResolveOpts::new(common.voice_path.clone(), cache_dir);
    let voice_model = resolve_voice(
        Some(&voice_id),
        &opts,
        &UreqVoiceSource,
        progress.map(|p| p as &dyn taletrek_worker::ProgressSink),
    )
    .context("resolving voice model")?;

    // Parallel synth + manifest stamp. A fresh runner is constructed per work
    // chunk via the factory (the native engine loads its model once per
    // chunk); the encoder is shared by ref.
    let factory_voice_model = voice_model.clone();
    synth_and_stamp(
        &mut bundle,
        &voice_id,
        &voice_model,
        move || make_runner_of(&factory_voice_model),
        encoder,
        jobs,
        progress.map(|p| p as &dyn taletrek_worker::ProgressSink),
    )?;

    // Write the full bundle out: explicit --output, else <stem>.synth.taletrek
    // beside the input (a chained source keeps its own stem: fable.txt →
    // fable.synth.taletrek — the unchanged naming rule).
    let output = common
        .output
        .clone()
        .unwrap_or_else(|| default_synth_output(&common.input));
    write_book_bundle_file(&bundle, &output)
        .with_context(|| format!("writing output bundle {}", output.display()))?;
    if let Some(p) = progress {
        p.summary("synth", bundle.audio.len(), &voice_id, &output);
    }
    Ok(())
}

/// `synth --input` dispatch: a `.taletrek` file is read as a bundle (the
/// original two-step path); any other known source extension is parsed in
/// memory into a fresh text-only bundle (the chained one-command path — no
/// intermediate file). Anything else is the T5 typed error.
///
/// The chained bundle is stamped with `voice_id` — the voice `synth` will use —
/// so the manifest and the content-addressed audio keys agree.
fn load_synth_input(input: &Path, voice_id: &str) -> Result<BookBundle> {
    let is_bundle = input
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("taletrek"));
    if is_bundle {
        let input_bytes =
            fs::read(input).with_context(|| format!("reading input bundle {}", input.display()))?;
        return Ok(read_book_bundle(&input_bytes)?);
    }

    let format = source_format_for_extension(input)?;
    let input_bytes =
        fs::read(input).with_context(|| format!("reading source document {}", input.display()))?;
    let hint = input
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned);
    let book = taletrek_parse::parse_source(&input_bytes, format, hint.as_deref())?;
    Ok(taletrek_parse::to_text_only_bundle(
        &book,
        voice_id,
        desktop_generator(),
    ))
}

/// `resynth` subcommand handler.
///
/// Re-voices a bundle (text-only OR full) with a new voice. Unlike `synth`,
/// already-full input is accepted — that's the primary use case. The manifest's
/// `book.voiceId` is rewritten to the new voice before synth so the stamped
/// manifest and content-addressed cache keys agree. Progress mirrors `synth`.
///
/// Engines mirror `synth` (T5): in-process defaults, `--piper`/`--ffmpeg`
/// independent overrides, native default 2 jobs / subprocess CPU count,
/// explicit `--jobs` always wins.
fn run_resynth(common: CommonArgs) -> Result<()> {
    let progress = Progress::to_stderr();

    // Load: resynth accepts text-only OR full input (no refuse_full_input guard).
    let input_bytes = fs::read(&common.input)
        .with_context(|| format!("reading input bundle {}", common.input.display()))?;
    let mut bundle = read_book_bundle(&input_bytes)?;

    // Resolve the new voice model: curated id (cache or download) or --voice-path.
    let cache_dir = default_cache_dir().context(
        "no platform cache directory discovered (set $HOME or pass --voice-path to use a local model)",
    )?;
    let opts = ResolveOpts::new(common.voice_path.clone(), cache_dir);
    let voice_model = resolve_voice(
        common.voice.as_deref(),
        &opts,
        &UreqVoiceSource,
        Some(&progress),
    )
    .context("resolving voice model")?;
    let voice_id = common
        .voice
        .clone()
        .unwrap_or_else(|| DEFAULT_VOICE_ID.to_string());

    // Re-voice: rewrite manifest.voiceId, then parallel synth under the new
    // voice (replacing the audio map — stale segments under the old voice are
    // discarded, not merged). Engine selection mirrors synth: native defaults,
    // independent --piper/--ffmpeg overrides.
    let runner_spec = RunnerSpec::select(common.piper.as_deref())?;
    let encoder = DesktopEncoder::select(common.ffmpeg.as_deref())?;
    let jobs = effective_jobs(common.jobs, &runner_spec);
    let factory_voice_model = voice_model.clone();
    resynth_and_stamp(
        &mut bundle,
        &voice_id,
        &voice_model,
        move || DesktopRunner::new(runner_spec.clone(), &factory_voice_model),
        &encoder,
        jobs,
        Some(&progress),
    )?;

    // Write the re-voiced bundle out: explicit --output, else
    // <stem>.<voice>.taletrek beside the input.
    let output = common
        .output
        .clone()
        .unwrap_or_else(|| default_resynth_output(&common.input, &voice_id));
    write_book_bundle_file(&bundle, &output)
        .with_context(|| format!("writing output bundle {}", output.display()))?;
    progress.summary("resynth", bundle.audio.len(), &voice_id, &output);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;
    use crate::cli::ParseArgs;

    use taletrek_synth::read_book_bundle;
    use taletrek_worker::DEFAULT_VOICE_ID;

    /// Write `contents` to `dir/name` and return its path.
    fn write_input(dir: &std::path::Path, name: &str, contents: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
        path
    }

    #[test]
    fn run_parse_txt_writes_importable_text_only_bundle_beside_input() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(
            dir.path(),
            "fable.txt",
            "Chapter One\n\nThe North Wind and the Sun were disputing.\n\nChapter Two\n\nThey parted as friends.",
        );

        run_parse(ParseArgs {
            input: input.clone(),
            voice: DEFAULT_VOICE_ID.to_string(),
            output: None,
        })
        .expect("parse should succeed");

        // Default output lands beside the input as <stem>.taletrek.
        let output = dir.path().join("fable.taletrek");
        assert!(
            output.is_file(),
            "default output must exist at {}",
            output.display()
        );

        let bytes = fs::read(&output).unwrap();
        let bundle = read_book_bundle(&bytes).expect("output must be a valid .taletrek bundle");
        let m = &bundle.manifest;
        assert!(!m.audio.present, "parse output is text-only");
        assert!(bundle.audio.is_empty());
        assert_eq!(m.book.source_format, "txt");
        assert_eq!(m.book.voice_id, DEFAULT_VOICE_ID);
        assert_eq!(m.book.title, "fable");
        assert_eq!(m.book.chapter_count, 2, "txt chapter line-split ran");
        assert_eq!(m.generator.app, crate::bundle_io::GENERATOR_APP);
        assert!(m.book.id.starts_with("bk_"), "fresh book id stamped");
    }

    #[test]
    fn run_parse_honors_explicit_output_and_voice() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "one.txt", "Just one paragraph.");

        let output = dir.path().join("custom.taletrek");
        run_parse(ParseArgs {
            input,
            voice: "en_US-ryan-medium".to_string(),
            output: Some(output.clone()),
        })
        .expect("parse should succeed");

        assert!(output.is_file());
        let bundle = read_book_bundle(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(bundle.manifest.book.voice_id, "en_US-ryan-medium");
        assert!(
            !dir.path().join("one.taletrek").exists(),
            "no stray default output"
        );
    }

    #[test]
    fn run_parse_unknown_extension_is_a_typed_error_listing_formats() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "book.mobi", "bytes");

        let err = run_parse(ParseArgs {
            input,
            voice: DEFAULT_VOICE_ID.to_string(),
            output: None,
        })
        .expect_err("unknown extension must error, not parse as txt");

        let typed = err
            .downcast::<UnsupportedExtensionError>()
            .expect("error must be the typed UnsupportedExtensionError");
        assert!(
            typed.to_string().contains(".epub"),
            "message lists supported formats"
        );
        assert!(typed.to_string().contains(".txt"));
        assert!(
            typed.to_string().contains("book.mobi"),
            "message names the input"
        );
    }

    #[test]
    fn run_parse_extensionless_input_is_the_same_typed_error() {
        let err = run_parse(ParseArgs {
            input: std::path::PathBuf::from("/tmp/README"),
            voice: DEFAULT_VOICE_ID.to_string(),
            output: None,
        })
        .expect_err("no extension → unsupported, not a filesystem error");
        assert!(err.downcast::<UnsupportedExtensionError>().is_ok());
    }

    #[test]
    fn extension_map_covers_every_supported_extension() {
        use taletrek_parse::SourceFormat;
        let cases = [
            ("book.epub", SourceFormat::Epub),
            ("book.txt", SourceFormat::Txt),
            ("book.html", SourceFormat::Html),
            ("book.htm", SourceFormat::Html),
            ("book.md", SourceFormat::Md),
            ("book.markdown", SourceFormat::Md),
            ("book.docx", SourceFormat::Docx),
            ("book.pdf", SourceFormat::Pdf),
            // Uppercase extensions map too (case-insensitive).
            ("BOOK.TXT", SourceFormat::Txt),
        ];
        for (name, expected) in cases {
            assert_eq!(
                source_format_for_extension(std::path::Path::new(name)).unwrap(),
                expected,
                "extension of {name}"
            );
        }
    }

    // ---- chained synth (T11) ----

    use taletrek_synth::synth::{PiperRunner, SynthError};
    use taletrek_synth::{AudioCodec, WavPassthrough};

    /// Canonical mono 16-bit 16 kHz WAV wrapping `pcm` — the shape Piper
    /// emits on stdout. Mirrors the stub in `bundle_io` tests so the chained
    /// dispatch tests here stay self-contained.
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

    /// In-process runner: a fixed canonical WAV regardless of input.
    struct StubRunner;

    impl PiperRunner for StubRunner {
        fn predict(
            &mut self,
            _voice_model: &std::path::Path,
            _text: &str,
        ) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    /// Write the dummy voice-model pair `resolve_voice`'s `--voice-path` path
    /// pre-checks for (an `.onnx` + sibling `.json`; contents are never read
    /// by the stub runner). Returns the `.onnx` path.
    fn dummy_voice_model(dir: &std::path::Path) -> std::path::PathBuf {
        let onnx = dir.join("stub.onnx");
        fs::write(&onnx, b"dummy model").unwrap();
        fs::write(dir.join("stub.json"), b"{}").unwrap();
        onnx
    }

    /// `CommonArgs` pointing at `input` with the stub voice model, one job,
    /// and no engine overrides (the runner/encoder seams are injected by the
    /// caller of `run_synth_with` — nothing is ever spawned).
    fn synth_args(input: &std::path::Path, voice_model: &std::path::Path) -> CommonArgs {
        CommonArgs {
            input: input.to_path_buf(),
            voice: None,
            voice_path: Some(voice_model.to_path_buf()),
            output: None,
            jobs: Some(1),
            piper: None,
            ffmpeg: None,
        }
    }

    #[test]
    fn run_synth_with_chained_txt_source_synthesizes_without_a_bundle_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(
            dir.path(),
            "fable.txt",
            "Chapter One\n\nThe North Wind and the Sun were disputing.\n\nChapter Two\n\nThey parted as friends.",
        );
        let voice_model = dummy_voice_model(dir.path());

        run_synth_with(
            synth_args(&input, &voice_model),
            None,
            |_| StubRunner,
            &WavPassthrough,
            1,
        )
        .expect("chained synth should succeed");

        // Default output for a chained run: <stem>.synth.taletrek beside the
        // source — the unchanged synth naming rule applied to the source path.
        let output = dir.path().join("fable.synth.taletrek");
        assert!(output.is_file(), "chained output at {}", output.display());
        // The chain is in memory: no intermediate text-only bundle is written.
        assert!(
            !dir.path().join("fable.taletrek").exists(),
            "no intermediate .taletrek may hit disk"
        );

        let bundle = read_book_bundle(&fs::read(&output).unwrap()).unwrap();
        assert!(bundle.manifest.audio.present, "chained output is full");
        assert_eq!(
            bundle.manifest.audio.codec,
            AudioCodec::Wav,
            "stub encoder codec"
        );
        assert_eq!(
            bundle.manifest.audio.segment_count, 2,
            "2 distinct paragraphs"
        );
        assert_eq!(bundle.audio.len(), 2);
        assert_eq!(bundle.manifest.book.voice_id, DEFAULT_VOICE_ID);
        assert_eq!(bundle.manifest.book.source_format, "txt");
        assert_eq!(bundle.manifest.book.chapter_count, 2);
        assert_eq!(
            bundle.manifest.generator.app,
            crate::bundle_io::GENERATOR_APP
        );
        for seg in bundle.audio.values() {
            assert!(seg.bytes.starts_with(b"RIFF"), "stub WAV passthrough");
        }
    }

    #[test]
    fn run_synth_with_taletrek_input_still_loads_the_bundle_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let source = write_input(
            dir.path(),
            "fable.txt",
            "Chapter One\n\nThe North Wind and the Sun were disputing.\n\nChapter Two\n\nThey parted as friends.",
        );
        run_parse(ParseArgs {
            input: source,
            voice: DEFAULT_VOICE_ID.to_string(),
            output: None,
        })
        .expect("parse should succeed");
        let input = dir.path().join("fable.taletrek");
        let voice_model = dummy_voice_model(dir.path());

        run_synth_with(
            synth_args(&input, &voice_model),
            None,
            |_| StubRunner,
            &WavPassthrough,
            1,
        )
        .expect("bundle-input synth should succeed");

        let output = dir.path().join("fable.synth.taletrek");
        assert!(output.is_file(), "default synth output beside input");
        let bundle = read_book_bundle(&fs::read(&output).unwrap()).unwrap();
        assert!(bundle.manifest.audio.present);
        assert_eq!(bundle.manifest.audio.segment_count, 2);
    }

    #[test]
    fn run_synth_with_unknown_source_extension_is_the_t5_typed_error() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "book.mobi", "bytes");
        let voice_model = dummy_voice_model(dir.path());

        let err = run_synth_with(
            synth_args(&input, &voice_model),
            None,
            |_| StubRunner,
            &WavPassthrough,
            1,
        )
        .expect_err("unknown extension must error before any synth");

        let typed = err
            .downcast::<UnsupportedExtensionError>()
            .expect("error must be the typed UnsupportedExtensionError");
        assert!(typed.to_string().contains("book.mobi"));
    }
}
