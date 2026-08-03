//! Command-line interface for `taletrek-desktop`.
//!
//! Two subcommands share a common flag set ([`CommonArgs`]):
//! - `synth` — synthesize a text-only bundle into a full audio bundle.
//! - `resynth` — re-synthesize a bundle with a different voice.
//!
//! Phase 1 (T2.1) wires only parsing + dispatch stubs; the synth/resynth
//! implementations land in later phases (T2.3–T2.5).

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// Top-level CLI parsed from `std::env::args`.
#[derive(Parser, Debug)]
#[command(
    name = "taletrek-desktop",
    version,
    about = "Off-device TaleTrek synth — text-only .taletrek bundle in, full bundle out"
)]
pub struct Cli {
    /// The subcommand to run.
    #[command(subcommand)]
    pub command: Cmd,
}

/// The available subcommands.
#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Synthesize a text-only bundle into a full audio bundle.
    Synth {
        /// Shared flags.
        #[command(flatten)]
        common: CommonArgs,
    },
    /// Re-synthesize a bundle with a different voice (whole-book voice swap).
    Resynth {
        /// Shared flags.
        #[command(flatten)]
        common: CommonArgs,
    },
}

/// Flags shared by `synth` and `resynth`.
#[derive(Args, Debug)]
pub struct CommonArgs {
    /// Input bundle path (`.taletrek`).
    #[arg(long)]
    pub input: PathBuf,

    /// Voice id (curated, e.g. `en_US-hfc_female-medium`). Downloaded on first
    /// use. Omit to use the default curated voice (`en_US-hfc_female-medium`).
    #[arg(long)]
    pub voice: Option<String>,

    /// Override: path to a Piper `.onnx` voice model. Skips download; the
    /// adjacent `<stem>.json` config is auto-discovered by Piper.
    #[arg(long = "voice-path")]
    pub voice_path: Option<PathBuf>,

    /// Output bundle path. Default: beside the input (`<stem>.synth.taletrek`
    /// for `synth`, `<stem>.<voice>.taletrek` for `resynth`).
    #[arg(long)]
    pub output: Option<PathBuf>,

    /// Parallel synth jobs. Default: number of CPUs.
    #[arg(long)]
    pub jobs: Option<usize>,

    /// Piper binary path (default: `piper`, resolved from `PATH`).
    #[arg(long, default_value = "piper")]
    pub piper: String,

    /// `ffmpeg` binary path (default: `ffmpeg`, resolved from `PATH`).
    #[arg(long, default_value = "ffmpeg")]
    pub ffmpeg: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synth_parses_minimal_with_defaults() {
        let cli = Cli::parse_from(["taletrek-desktop", "synth", "--input", "book.taletrek"]);
        let Cmd::Synth { common } = cli.command else {
            panic!("expected Synth, got {:?}", cli.command);
        };
        assert_eq!(common.input, PathBuf::from("book.taletrek"));
        assert!(
            common.voice.is_none(),
            "voice omitted → None (resolved later)"
        );
        assert!(common.voice_path.is_none());
        assert!(common.output.is_none());
        assert!(common.jobs.is_none());
        assert_eq!(common.piper, "piper");
        assert_eq!(common.ffmpeg, "ffmpeg");
    }

    #[test]
    fn resynth_parses_voice_and_jobs() {
        let cli = Cli::parse_from([
            "taletrek-desktop",
            "resynth",
            "--input",
            "full.taletrek",
            "--voice",
            "en_US-ryan-medium",
            "--jobs",
            "4",
        ]);
        let Cmd::Resynth { common } = cli.command else {
            panic!("expected Resynth, got {:?}", cli.command);
        };
        assert_eq!(common.voice.as_deref(), Some("en_US-ryan-medium"));
        assert_eq!(common.jobs, Some(4));
    }

    #[test]
    fn voice_path_override_parses() {
        let cli = Cli::parse_from([
            "taletrek-desktop",
            "synth",
            "--input",
            "x.taletrek",
            "--voice-path",
            "/voices/ryan.onnx",
        ]);
        let Cmd::Synth { common } = cli.command else {
            panic!("expected Synth");
        };
        assert_eq!(
            common.voice_path.as_deref(),
            Some(std::path::Path::new("/voices/ryan.onnx"))
        );
    }

    #[test]
    fn missing_input_is_rejected() {
        let result = Cli::try_parse_from(["taletrek-desktop", "synth"]);
        assert!(result.is_err(), "--input is required");
    }
}
