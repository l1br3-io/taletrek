//! Command-line interface for `taletrek-desktop`.
//!
//! Subcommands (effort `desktop-synth-gui` T7):
//! - *(none)* — bare invocation opens the GUI (same as `gui`).
//! - `gui` — open the eframe window (queue → convert → `.taletrek`).
//! - `parse` — parse a source document (`.epub`/`.txt`/`.html`/`.md`/
//!   `.docx`/`.pdf`) into a text-only bundle. Owns its flag set
//!   ([`ParseArgs`]): no voice model, no jobs — nothing to synthesize.
//! - `synth` — synthesize a text-only bundle into a full audio bundle; when
//!   `--input` names a source document instead, parse it in memory first
//!   (the chained one-command path, kernel-parse T11).
//! - `resynth` — re-synthesize a bundle with a different voice (bundle-only).
//!
//! (The latter three share [`CommonArgs`]; synth wiring landed in phases
//! T2.3–T2.6 of the desktop effort, parse in kernel-parse T5.)

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

use taletrek_worker::DEFAULT_VOICE_ID;

/// Top-level CLI parsed from `std::env::args`.
#[derive(Parser, Debug)]
#[command(
    name = "taletrek-desktop",
    version,
    about = "TaleTrek desktop kernel — turn documents into .taletrek audiobooks (GUI by default, or parse/synth/resynth subcommands)"
)]
pub struct Cli {
    /// The subcommand to run. Omitted (bare `taletrek-desktop`) → the GUI.
    #[command(subcommand)]
    pub command: Option<Cmd>,
}

/// The available subcommands.
#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Open the TaleTrek window (the default when no subcommand is given).
    Gui,
    /// Parse a source document into a text-only `.taletrek` bundle.
    Parse {
        /// Parse-specific flags.
        #[command(flatten)]
        args: ParseArgs,
    },
    /// Synthesize a text-only bundle into a full audio bundle. `--input` may
    /// also name a source document (`.epub`/`.txt`/`.html`/`.md`/`.docx`/
    /// `.pdf`) — it is parsed in memory first (chained one-command path).
    Synth {
        /// Shared flags.
        #[command(flatten)]
        common: CommonArgs,
    },
    /// Re-synthesize a bundle with a different voice (whole-book voice swap).
    /// Bundle-only: `--input` must be a `.taletrek` (full or text-only) —
    /// source documents belong to `synth`.
    Resynth {
        /// Shared flags.
        #[command(flatten)]
        common: CommonArgs,
    },
    /// Hidden benchmark harness (progressive-synth task 001): convert a
    /// document through the real synth engine and print a timing report
    /// (wall, per-paragraph/chunk percentiles, synth/encode split, RTF).
    #[command(hide = true)]
    BenchSynth {
        /// Bench flags.
        #[command(flatten)]
        args: BenchArgs,
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
    /// Input bundle path (`.taletrek`). `synth` also accepts a source
    /// document (`.epub`, `.txt`, `.html`, `.htm`, `.md`, `.markdown`,
    /// `.docx`, `.pdf`) — parsed in memory first, then synthesized
    /// (chained one-command path). `resynth` is bundle-only.
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

    /// Parallel synth jobs. Default: 2 for the in-process engine (each job
    /// holds a ~212 MB model; T3's memory note), the CPU count for the
    /// `--piper` subprocess engine.
    #[arg(long)]
    pub jobs: Option<usize>,

    /// Override: use a Piper subprocess binary for synthesis instead of the
    /// default in-process engine (sherpa-onnx). The binary is resolved from
    /// `PATH` when given as a bare name.
    #[arg(long)]
    pub piper: Option<String>,

    /// Override: encode via an `ffmpeg` subprocess binary (libopus) instead
    /// of the default in-process Opus encoder. Resolved from `PATH` when
    /// given as a bare name.
    #[arg(long)]
    pub ffmpeg: Option<String>,
}

/// Flags for the hidden `bench-synth` harness. A trimmed [`CommonArgs`]:
/// no `--output` (the bench prints a report, not a bundle), plus the same
/// engine overrides so either side can be benchmarked.
#[derive(Args, Debug)]
pub struct BenchArgs {
    /// Input document: a source (`.epub`, `.txt`, `.html`, `.htm`, `.md`,
    /// `.markdown`, `.docx`, `.pdf`) parsed in memory, or a text-only
    /// `.taletrek` bundle.
    #[arg(long)]
    pub input: PathBuf,

    /// Parallel synth jobs. Default: 2 for the in-process engine, the CPU
    /// count for the `--piper` subprocess engine.
    #[arg(long)]
    pub jobs: Option<usize>,

    /// Voice id (curated, e.g. `en_US-hfc_female-medium`). Downloaded on
    /// first use. Omit for the curated default.
    #[arg(long)]
    pub voice: Option<String>,

    /// Override: path to a Piper `.onnx` voice model. Skips download.
    #[arg(long = "voice-path")]
    pub voice_path: Option<PathBuf>,

    /// Override: use a Piper subprocess binary for synthesis instead of the
    /// default in-process engine (sherpa-onnx).
    #[arg(long)]
    pub piper: Option<String>,

    /// Override: encode via an `ffmpeg` subprocess binary instead of the
    /// default in-process Opus encoder.
    #[arg(long)]
    pub ffmpeg: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_invocation_parses_with_no_subcommand_the_gui_default() {
        let cli = Cli::parse_from(["taletrek-desktop"]);
        assert!(
            cli.command.is_none(),
            "bare run → None (main dispatches to the GUI)"
        );
    }

    #[test]
    fn gui_subcommand_parses() {
        let cli = Cli::parse_from(["taletrek-desktop", "gui"]);
        assert!(matches!(cli.command, Some(Cmd::Gui)));
    }

    #[test]
    fn synth_parses_minimal_with_defaults() {
        let cli = Cli::parse_from(["taletrek-desktop", "synth", "--input", "book.taletrek"]);
        let Some(Cmd::Synth { common }) = cli.command else {
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
        assert!(
            common.piper.is_none(),
            "piper omitted → None (in-process engine is the default)"
        );
        assert!(
            common.ffmpeg.is_none(),
            "ffmpeg omitted → None (in-process encoder is the default)"
        );
    }

    #[test]
    fn synth_parses_explicit_subprocess_overrides() {
        let cli = Cli::parse_from([
            "taletrek-desktop",
            "synth",
            "--input",
            "book.taletrek",
            "--piper",
            "/opt/piper/piper",
            "--ffmpeg",
            "/opt/ffmpeg/bin/ffmpeg",
        ]);
        let Some(Cmd::Synth { common }) = cli.command else {
            panic!("expected Synth, got {:?}", cli.command);
        };
        assert_eq!(common.piper.as_deref(), Some("/opt/piper/piper"));
        assert_eq!(common.ffmpeg.as_deref(), Some("/opt/ffmpeg/bin/ffmpeg"));
    }

    #[test]
    fn overrides_are_independent() {
        // Either override alone parses: native runner + ffmpeg encode, or
        // piper runner + native encode.
        let cli = Cli::parse_from([
            "taletrek-desktop",
            "synth",
            "--input",
            "b.taletrek",
            "--piper",
            "piper",
        ]);
        let Some(Cmd::Synth { common }) = cli.command else {
            panic!("expected Synth");
        };
        assert_eq!(common.piper.as_deref(), Some("piper"));
        assert!(common.ffmpeg.is_none());

        let cli = Cli::parse_from([
            "taletrek-desktop",
            "resynth",
            "--input",
            "b.taletrek",
            "--ffmpeg",
            "ffmpeg",
        ]);
        let Some(Cmd::Resynth { common }) = cli.command else {
            panic!("expected Resynth");
        };
        assert!(common.piper.is_none());
        assert_eq!(common.ffmpeg.as_deref(), Some("ffmpeg"));
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
        let Some(Cmd::Resynth { common }) = cli.command else {
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
        let Some(Cmd::Synth { common }) = cli.command else {
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
        let Some(Cmd::Parse { args }) = cli.command else {
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
        let Some(Cmd::Parse { args }) = cli.command else {
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

    #[test]
    fn help_documents_the_chained_synth_and_bundle_only_resynth() {
        use clap::CommandFactory as _;
        let cmd = Cli::command();
        let synth_about = cmd
            .find_subcommand("synth")
            .and_then(|c| c.get_about())
            .map(|s| s.to_string())
            .unwrap_or_default();
        assert!(
            synth_about.to_lowercase().contains("source"),
            "synth --help must mention source documents (chained path), got: {synth_about}"
        );
        let resynth_about = cmd
            .find_subcommand("resynth")
            .and_then(|c| c.get_about())
            .map(|s| s.to_string())
            .unwrap_or_default();
        assert!(
            resynth_about.to_lowercase().contains("bundle"),
            "resynth --help must document that it is bundle-only, got: {resynth_about}"
        );
    }

    #[test]
    fn bench_synth_parses_minimal_with_defaults() {
        let cli = Cli::parse_from(["taletrek-desktop", "bench-synth", "--input", "novel.epub"]);
        let Some(Cmd::BenchSynth { args }) = cli.command else {
            panic!("expected BenchSynth, got {:?}", cli.command);
        };
        assert_eq!(args.input, PathBuf::from("novel.epub"));
        assert!(args.jobs.is_none());
        assert!(args.voice.is_none());
        assert!(args.voice_path.is_none());
        assert!(args.piper.is_none());
        assert!(args.ffmpeg.is_none());
    }

    #[test]
    fn bench_synth_parses_jobs_and_engine_overrides() {
        let cli = Cli::parse_from([
            "taletrek-desktop",
            "bench-synth",
            "--input",
            "novel.epub",
            "--jobs",
            "4",
            "--voice",
            "en_US-ryan-medium",
            "--piper",
            "piper",
            "--ffmpeg",
            "ffmpeg",
        ]);
        let Some(Cmd::BenchSynth { args }) = cli.command else {
            panic!("expected BenchSynth");
        };
        assert_eq!(args.jobs, Some(4));
        assert_eq!(args.voice.as_deref(), Some("en_US-ryan-medium"));
        assert_eq!(args.piper.as_deref(), Some("piper"));
        assert_eq!(args.ffmpeg.as_deref(), Some("ffmpeg"));
    }

    #[test]
    fn bench_synth_is_hidden_from_help() {
        // The harness is developer tooling — it must parse but never show in
        // `--help` listings.
        use clap::CommandFactory as _;
        let cmd = Cli::command();
        assert!(
            cmd.find_subcommand("bench-synth")
                .is_some_and(|c| c.is_hide_set()),
            "bench-synth must exist and be hidden"
        );
    }
}
