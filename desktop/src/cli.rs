//! Command-line interface for `taletrek-desktop`.
//!
//! Three subcommands:
//! - `parse` — parse a source document (`.epub`/`.txt`/`.html`/`.md`/
//!   `.docx`/`.pdf`) into a text-only bundle. Owns its flag set
//!   ([`ParseArgs`]): no voice model, no jobs — nothing to synthesize.
//! - `synth` — synthesize a text-only bundle into a full audio bundle.
//! - `resynth` — re-synthesize a bundle with a different voice.
//!
//! (The latter two share [`CommonArgs`]; synth wiring landed in phases
//! T2.3–T2.6 of the desktop effort, parse in kernel-parse T5.)

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

use taletrek_worker::DEFAULT_VOICE_ID;

/// Top-level CLI parsed from `std::env::args`.
#[derive(Parser, Debug)]
#[command(
    name = "taletrek-desktop",
    version,
    about = "TaleTrek desktop kernel — parse source documents into .taletrek bundles, synth/resynth them to audio"
)]
pub struct Cli {
    /// The subcommand to run.
    #[command(subcommand)]
    pub command: Cmd,
}

/// The available subcommands.
#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Parse a source document into a text-only `.taletrek` bundle.
    Parse {
        /// Parse-specific flags.
        #[command(flatten)]
        args: ParseArgs,
    },
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

/// Flags for `parse`.
#[derive(Args, Debug)]
pub struct ParseArgs {
    /// Input source document (`.epub`, `.txt`, `.html`, `.htm`, `.md`,
    /// `.markdown`, `.docx`, or `.pdf`).
    #[arg(long)]
    pub input: PathBuf,

    /// Voice id stamped into the manifest — the voice a later `synth` will
    /// use. Omit for the curated default (`en_US-hfc_female-medium`).
    #[arg(long, default_value = DEFAULT_VOICE_ID)]
    pub voice: String,

    /// Output bundle path. Default: beside the input (`<stem>.taletrek`).
    #[arg(long)]
    pub output: Option<PathBuf>,
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

    #[test]
    fn parse_defaults_voice_to_curated_default() {
        let cli = Cli::parse_from(["taletrek-desktop", "parse", "--input", "book.txt"]);
        let Cmd::Parse { args } = cli.command else {
            panic!("expected Parse, got {:?}", cli.command);
        };
        assert_eq!(args.input, PathBuf::from("book.txt"));
        assert_eq!(
            args.voice, "en_US-hfc_female-medium",
            "voice omitted → curated default, resolved by clap"
        );
        assert!(
            args.output.is_none(),
            "output omitted → None (default applied by handler)"
        );
    }

    #[test]
    fn parse_accepts_explicit_voice_and_output() {
        let cli = Cli::parse_from([
            "taletrek-desktop",
            "parse",
            "--input",
            "novel.epub",
            "--voice",
            "en_US-ryan-medium",
            "--output",
            "out/novel.taletrek",
        ]);
        let Cmd::Parse { args } = cli.command else {
            panic!("expected Parse");
        };
        assert_eq!(args.voice, "en_US-ryan-medium");
        assert_eq!(args.output, Some(PathBuf::from("out/novel.taletrek")));
    }

    #[test]
    fn parse_missing_input_is_rejected() {
        let result = Cli::try_parse_from(["taletrek-desktop", "parse"]);
        assert!(result.is_err(), "--input is required");
    }
}
