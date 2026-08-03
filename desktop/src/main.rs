//! Entry point for `taletrek-desktop`.
//!
//! Phase 5 (T2.5) wires the `resynth` subcommand end-to-end:
//! read bundle (text-only OR full) → resolve new voice → rewrite book.voiceId
//! → parallel synth → stamp manifest → write `<stem>.<voice>.taletrek`.
//! `synth` was wired in Phase 4 (T2.4).

mod bundle_io;
mod cli;
mod synth_job;
mod voices;

use std::fs;
use std::thread::available_parallelism;

use anyhow::{Context, Result};
use clap::Parser;

use taletrek_synth::{read_book_bundle, OpusEncoder, SubprocessPiperRunner};

use crate::bundle_io::{
    default_resynth_output, default_synth_output, refuse_full_input, resynth_and_stamp,
    synth_and_stamp, write_book_bundle_file,
};
use crate::cli::{Cli, Cmd, CommonArgs};
use crate::voices::{
    default_cache_dir, resolve_voice, ResolveOpts, UreqVoiceSource, DEFAULT_VOICE_ID,
};

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
/// result beside the input (or to `--output`).
fn run_synth(common: CommonArgs) -> Result<()> {
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
    let voice_model = resolve_voice(common.voice.as_deref(), &opts, &UreqVoiceSource)
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
    )?;

    // Write the full bundle out: explicit --output, else <stem>.synth.taletrek
    // beside the input.
    let output = common
        .output
        .clone()
        .unwrap_or_else(|| default_synth_output(&common.input));
    write_book_bundle_file(&bundle, &output)
        .with_context(|| format!("writing output bundle {}", output.display()))?;
    eprintln!(
        "synth: {} segments, voice {voice_id} → {}",
        bundle.audio.len(),
        output.display()
    );
    Ok(())
}

/// `resynth` subcommand handler.
///
/// Re-voices a bundle (text-only OR full) with a new voice. Unlike `synth`,
/// already-full input is accepted — that's the primary use case. The manifest's
/// `book.voiceId` is rewritten to the new voice before synth so the stamped
/// manifest and content-addressed cache keys agree.
fn run_resynth(common: CommonArgs) -> Result<()> {
    // Load: resynth accepts text-only OR full input (no refuse_full_input guard).
    let input_bytes = fs::read(&common.input)
        .with_context(|| format!("reading input bundle {}", common.input.display()))?;
    let mut bundle = read_book_bundle(&input_bytes)?;

    // Resolve the new voice model: curated id (cache or download) or --voice-path.
    let cache_dir = default_cache_dir().context(
        "no platform cache directory discovered (set $HOME or pass --voice-path to use a local model)",
    )?;
    let opts = ResolveOpts::new(common.voice_path.clone(), cache_dir);
    let voice_model = resolve_voice(common.voice.as_deref(), &opts, &UreqVoiceSource)
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
    )?;

    // Write the re-voiced bundle out: explicit --output, else
    // <stem>.<voice>.taletrek beside the input.
    let output = common
        .output
        .clone()
        .unwrap_or_else(|| default_resynth_output(&common.input, &voice_id));
    write_book_bundle_file(&bundle, &output)
        .with_context(|| format!("writing output bundle {}", output.display()))?;
    eprintln!(
        "resynth: {} segments, voice {voice_id} → {}",
        bundle.audio.len(),
        output.display()
    );
    Ok(())
}

/// Resolve the default job count: the number of available parallel workers
/// (`std::thread::available_parallelism`), falling back to 1 when the platform
/// can't report it. Equivalent to the `num_cpus` crate without the dep.
fn default_jobs() -> usize {
    available_parallelism().map(|n| n.get()).unwrap_or(1)
}
