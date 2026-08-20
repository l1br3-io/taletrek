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

use taletrek_synth::{read_book_bundle, OpusEncoder, SubprocessPiperRunner};
use taletrek_worker::{
    default_cache_dir, resolve_voice, Progress, ResolveOpts, UreqVoiceSource, DEFAULT_VOICE_ID,
};

use crate::bundle_io::{
    default_resynth_output, default_synth_output, refuse_full_input, resynth_and_stamp,
    synth_and_stamp, write_book_bundle_file,
};
use crate::cli::{Cli, Cmd, CommonArgs};

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Synth { common } => run_synth(common),
        Cmd::Resynth { common } => run_resynth(common),
    }
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
