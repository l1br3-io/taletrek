//! Entry point for `taletrek-desktop`.
//!
//! Phase 6 (T2.6) wires a `Progress` sink (stderr behind a `Write` seam)
//! through both subcommands: download progress during voice resolution,
//! `synth [n/total] pct%` per paragraph, and a final `kind: N segments, voice
//! V, Mm Ss → out` summary line. `synth` was wired in Phase 4 (T2.4);
//! `resynth` in Phase 5 (T2.5).
//!
//! Effort 4 / T1: voice acquisition + progress reporting moved into the shared
//! `taletrek-worker` crate; this binary imports them. Behavior is identical.

mod bundle_io;
mod cli;

use std::fs;
use std::thread::available_parallelism;

use anyhow::{Context, Result};
use clap::Parser;

use taletrek_parse::SourceFormat;
use taletrek_synth::{read_book_bundle, OpusEncoder, SubprocessPiperRunner};
use taletrek_worker::{
    default_cache_dir, resolve_voice, Progress, ResolveOpts, UreqVoiceSource, DEFAULT_VOICE_ID,
};

use crate::bundle_io::{
    default_parse_output, default_resynth_output, default_synth_output, desktop_generator,
    refuse_full_input, resynth_and_stamp, synth_and_stamp, write_book_bundle_file,
};
use crate::cli::{Cli, Cmd, CommonArgs, ParseArgs};

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Parse { args } => run_parse(args),
        Cmd::Synth { common } => run_synth(common),
        Cmd::Resynth { common } => run_resynth(common),
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
/// Loads a text-only bundle, refuses an already-full input (pointing the user
/// at `resynth`), resolves the voice (curated download or `--voice-path`),
/// synthesizes every paragraph in parallel, stamps the manifest, and writes the
/// result beside the input (or to `--output`). Progress flows to stderr
/// throughout: voice-download bytes, per-paragraph synth count, and a final
/// summary.
fn run_synth(common: CommonArgs) -> Result<()> {
    let progress = Progress::to_stderr();

    // Load + guard: synth only accepts text-only bundles.
    let input_bytes = fs::read(&common.input)
        .with_context(|| format!("reading input bundle {}", common.input.display()))?;
    let mut bundle = read_book_bundle(&input_bytes)?;
    refuse_full_input(&bundle, &common.input)?;

    // Resolve the voice model: curated id (cache or download) or --voice-path.
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

    // Parallel synth + manifest stamp. A fresh runner is constructed per
    // paragraph (each task owns its own `&mut R`); the encoder is shared by ref.
    let encoder = OpusEncoder::new().with_binary(common.ffmpeg.clone());
    let piper_bin = common.piper.clone();
    let jobs = common.jobs.unwrap_or_else(default_jobs);
    synth_and_stamp(
        &mut bundle,
        &voice_id,
        &voice_model,
        move || SubprocessPiperRunner::new(&piper_bin),
        &encoder,
        jobs,
        Some(&progress),
    )?;

    // Write the full bundle out: explicit --output, else <stem>.synth.taletrek
    // beside the input.
    let output = common
        .output
        .clone()
        .unwrap_or_else(|| default_synth_output(&common.input));
    write_book_bundle_file(&bundle, &output)
        .with_context(|| format!("writing output bundle {}", output.display()))?;
    progress.summary("synth", bundle.audio.len(), &voice_id, &output);
    Ok(())
}

/// `resynth` subcommand handler.
///
/// Re-voices a bundle (text-only OR full) with a new voice. Unlike `synth`,
/// already-full input is accepted — that's the primary use case. The manifest's
/// `book.voiceId` is rewritten to the new voice before synth so the stamped
/// manifest and content-addressed cache keys agree. Progress mirrors `synth`.
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
    // discarded, not merged).
    let encoder = OpusEncoder::new().with_binary(common.ffmpeg.clone());
    let piper_bin = common.piper.clone();
    let jobs = common.jobs.unwrap_or_else(default_jobs);
    resynth_and_stamp(
        &mut bundle,
        &voice_id,
        &voice_model,
        move || SubprocessPiperRunner::new(&piper_bin),
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

/// Resolve the default job count: the number of available parallel workers
/// (`std::thread::available_parallelism`), falling back to 1 when the platform
/// can't report it. Equivalent to the `num_cpus` crate without the dep.
fn default_jobs() -> usize {
    available_parallelism().map(|n| n.get()).unwrap_or(1)
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
}
