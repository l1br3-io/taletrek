//! TaleTrek host-level synth worker — the shared host concerns between the
//! desktop CLI and the personal server (ADR-0013).
//!
//! This crate holds everything that is host-level (not pure synth): voice model
//! acquisition (HuggingFace download + XDG cache + curated catalog), and —
//! landing in later tasks of effort 4 — the parallel synth pool and manifest
//! stamping. [`taletrek_synth`] stays pure (no network, no threads); this crate
//! is the reusable layer both hosts (desktop = sync CLI, server = async-wrapped)
//! consume.
//!
//! Today (T1) the crate exposes the [`ProgressSink`] seam + the voice stack
//! (`voices` + its tightly-coupled `progress` reporter). The desktop imports
//! both here; its behavior is identical to the pre-extraction `desktop/`.
//!
//! # The `ProgressSink` seam
//!
//! Voice resolution + (soon) the synth pool report progress through
//! [`ProgressSink`]. Each host wires its own concrete reporter:
//! - **desktop** → [`Progress`] (stderr lines: `voice d.t MiB (pct%)`,
//!   `synth [n/total] pct%`).
//! - **server** → a job row's `done`/`total` columns in SQLite (lands in T9).
//!
//! The trait carries only the two methods the worker engine calls; host-only
//! concerns (the desktop's `summary` line, its `elapsed()` timer) stay off the
//! trait as inherent methods on the concrete type.

pub mod pipeline;
pub mod progress;
pub mod stamp;
pub mod store;
pub mod synth_job;
pub mod voices;

/// Seam between the worker engine (voice acquire, synth pool) and the host's
/// progress reporting.
///
/// The worker never decides *how* progress is shown — it only reports
/// `done`/`total` fractions through this trait. Each host supplies its own
/// implementation:
/// - the **desktop** CLI writes human-readable lines to stderr ([`Progress`]);
/// - the **server** updates a job row's `done`/`total` columns (effort 4, T9).
///
/// `Send + Sync` is a supertrait because the synth pool calls these methods
/// from rayon worker threads — the trait object must be shareable across
/// threads. Both hosts' reporters are already thread-safe ([`Progress`] wraps a
/// `Mutex`; the server's future job-row reporter will wrap DB access).
///
/// GOTCHA: only the two methods the engine calls live here. Host-only reporters
/// (the desktop's final `summary` line + `elapsed()` timer) are inherent on the
/// concrete [`Progress`] type — the server never summarizes, so they don't
/// belong on the shared trait.
pub trait ProgressSink: Send + Sync {
    /// Report synth progress: `done` of `total` paragraphs have completed.
    /// Hosts may skip when `total == 0` (nothing to report, e.g. an empty
    /// bundle).
    fn synth_step(&self, done: usize, total: usize);

    /// Report download progress: `bytes_done` of `bytes_total` fetched. A
    /// `bytes_total` of `0` means the source reported no length (e.g. no
    /// `Content-Length`); hosts render the total + pct as unknown.
    fn download_step(&self, bytes_done: u64, bytes_total: u64);
}

// Flat type re-exports — the primary public API.
pub use pipeline::{
    estimate_audio_seconds, CancelFlag, CancellableRunner, PipelineError, PipelineEvent,
    PipelineJob, PipelineOutcome, PipelinePhase, PipelineReporter, PipelineSpec, PipelineVariant,
    ProgressiveAnchor, RunnerFactory, HORIZON_SECONDS, PLAYABLE_SECONDS, SPEECH_CHARS_PER_SECOND,
};
pub use progress::Progress;
pub use stamp::{
    refuse_full_input, resynth_and_stamp, synth_and_stamp, synth_and_stamp_streaming,
    FullInputError, StampError,
};
pub use store::{SegmentStore, StoreError};
pub use synth_job::{
    synth_all_paragraphs, synth_paragraphs_into, synth_paragraphs_into_dynamic,
    ParagraphOrderPolicy, ParagraphPlanView, SegmentSink, SynthJobError,
};
pub use voices::{
    default_cache_dir, ensure_espeak_data, find_curated, resolve_voice, EspeakError, ResolveError,
    ResolveOpts, UreqVoiceSource, Voice, VoiceQuality, VoiceSource, CURATED_VOICES,
    DEFAULT_VOICE_ID, ESPEAK_ZIP_URL, HF_BASE,
};
