//! Entry point for `taletrek-desktop`.
//!
//! Phase 1 (T2.1): parse the CLI and dispatch to subcommand handlers. The
//! handlers are stubs that surface "not yet implemented" until their phases
//! land (`synth` → T2.3–T2.4, `resynth` → T2.5).

mod cli;
mod voices;

use clap::Parser;

use crate::cli::{Cli, Cmd, CommonArgs, DEFAULT_VOICE};

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Synth { common } => run_synth(common),
        Cmd::Resynth { common } => run_resynth(common),
    }
}

/// `synth` subcommand handler (stub — wiring lands in T2.3–T2.4).
fn run_synth(common: CommonArgs) -> anyhow::Result<()> {
    let voice = resolve_voice_label(&common);
    anyhow::bail!(
        "synth not yet implemented (Phase 1 skeleton): input={}, voice={voice}",
        common.input.display()
    )
}

/// `resynth` subcommand handler (stub — wiring lands in T2.5).
fn run_resynth(common: CommonArgs) -> anyhow::Result<()> {
    let voice = resolve_voice_label(&common);
    anyhow::bail!(
        "resynth not yet implemented (Phase 1 skeleton): input={}, voice={voice}",
        common.input.display()
    )
}

/// Render the effective voice id for diagnostics (default if `--voice` omitted).
fn resolve_voice_label(common: &CommonArgs) -> String {
    common
        .voice
        .clone()
        .unwrap_or_else(|| DEFAULT_VOICE.to_string())
}
