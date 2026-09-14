//! The GUI's job executor: owns the [`Queue`], runs one job at a time on a
//! background thread, and turns worker callbacks into queue events.
//!
//! # Division of labor
//!
//! - [`Queue`] state changes happen **only** in [`Queue::tick`], driven by
//!   [`WorkerMsg::Event`]s drained from the channel ([`Executor::drain`]) —
//!   no queue logic lives in egui code (T6's invariant).
//! - [`Executor::pump`] starts the next queued job when the executor is
//!   idle. "Idle" is thread bookkeeping (`current_job`), not queue state:
//!   the queue moves a job to `Running` only when the thread's
//!   [`QueueEvent::Started`] arrives (total paragraphs are unknown until
//!   the input is loaded), so the executor must remember what it spawned to
//!   avoid double-spawning in the frames before `Started` is drained.
//! - The job thread ([`spawn_job_thread`]) runs the full pipeline —
//!   parse-or-load → voice acquire (blocking download, progress forwarded)
//!   → native synth → bundle write — reporting through [`ChannelSink`] and
//!   ending with exactly one [`WorkerMsg::Exited`].
//!
//! # Cancellation (T9)
//!
//! [`Executor::cancel`] marks the queue row `Cancelled` immediately and, for
//! the running job, flips its cooperative [`CancelFlag`]. The flag is
//! checked per paragraph by [`CancellableRunner`] (the runner wrapper every
//! production factory installs), which raises [`SynthError::Cancelled`] so
//! rayon's abort-on-first-error short-circuit unwinds the pool promptly; the
//! job core also checks it at stage boundaries ([`ensure_not_cancelled`]),
//! most importantly **before the bundle write** — a cancelled job can never
//! leave a half-written file. The dying thread's final `Failed` event
//! no-ops against the already-`Cancelled` row; its [`WorkerMsg::Exited`]
//! then admits the next job.
//!
//! # Failures (T9)
//!
//! Job errors arrive as `anyhow` chains whose innermost causes are the
//! kernel's typed errors ([`SynthError`], parse and bundle errors). The
//! thread maps them to a single human sentence via [`humanize_error`]
//! before reporting, so a `Failed` row explains itself ("install piper…",
//! "the EPUB file is malformed…") instead of quoting a chain.
//!
//! # Shutdown
//!
//! [`Executor::shutdown`] joins the running job thread: closing the window
//! while a job runs waits for that job to finish so the output bundle is
//! never half-written (a hard kill is deliberately out of scope).

use std::any::Any;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use crossbeam_channel::{Receiver, Sender};

use taletrek_synth::synth::{PiperRunner, SynthError};
use taletrek_synth::{read_book_bundle, BookBundle, Encoder};
use taletrek_worker::{default_cache_dir, resolve_voice, ResolveOpts, UreqVoiceSource};

use super::queue::{Job, JobId, JobKind, Queue, QueueEvent};
use super::settings::{resolve_output, RunConfig};
use super::sink::{ChannelSink, WorkerMsg};
use crate::bundle_io::{
    default_resynth_output, default_synth_output, refuse_full_input, resynth_and_stamp,
    synth_stamp_to_file, write_book_bundle_file, FullInputError,
};
use crate::engine::{DesktopEncoder, DesktopRunner, RunnerSpec};

/// The cooperative cancel signal shared between the executor (writer) and
/// one job thread (reader). `Arc<AtomicBool>` by construction; `Relaxed`
/// loads are enough — a missed paragraph just delays the exit by one.
pub type CancelFlag = Arc<AtomicBool>;

/// How the executor starts a job thread. A seam so unit tests script job
/// outcomes (canned event sequences) instead of running the real engine.
///
/// The contract: the returned thread must send [`WorkerMsg::Exited`] for the
/// job as its **last** message, on every exit path — that is what clears
/// the executor's bookkeeping and admits the next job.
type JobThreadSpawner =
    Box<dyn FnMut(Job, Sender<WorkerMsg>, CancelFlag, RunConfig) -> JoinHandle<()>>;

/// The queue's owner and thread manager — one per GUI process.
///
/// The egui layer calls [`drain`](Executor::drain) +
/// [`pump`](Executor::pump) once per frame (drain first: a job finishing
/// frees its slot in the same frame), renders [`queue`](Executor::queue),
/// and calls [`shutdown`](Executor::shutdown) on exit.
pub struct Executor {
    /// The single source of truth for job states.
    queue: Queue,
    /// Job-thread → GUI-thread messages (clone handed to each spawn).
    tx: Sender<WorkerMsg>,
    /// The draining end of [`Self::tx`].
    rx: Receiver<WorkerMsg>,
    /// The job whose thread is spawned (Running or pre-`Started`). `None`
    /// means idle — the next `pump` may spawn. Distinct from queue state
    /// (see [module docs](self)) — this is thread bookkeeping.
    current_job: Option<JobId>,
    /// The running thread's cooperative cancel flag (mirrors
    /// [`Self::current_job`]); flipped by [`Executor::cancel`].
    current_cancel: Option<CancelFlag>,
    /// The running thread's join handle (for graceful shutdown).
    current_handle: Option<JoinHandle<()>>,
    /// Latest voice-download byte counts for the current job — render-only
    /// ephemera the queue deliberately does not model.
    download: Option<(u64, u64)>,
    /// Injectable thread spawner (tests script outcomes through it).
    spawn: JobThreadSpawner,
}

impl Executor {
    /// An idle executor using the real job pipeline.
    pub fn new() -> Self {
        Self::with_spawner(Box::new(spawn_job_thread))
    }

    /// Build with an injected spawner — the unit-test seam.
    fn with_spawner(spawn: JobThreadSpawner) -> Self {
        let (tx, rx) = crossbeam_channel::unbounded();
        Self {
            queue: Queue::new(),
            tx,
            rx,
            current_job: None,
            current_cancel: None,
            current_handle: None,
            download: None,
            spawn,
        }
    }

    /// The rendered queue — read-only access for the egui layer.
    pub fn queue(&self) -> &Queue {
        &self.queue
    }

    /// The job whose thread is currently spawned, if any — lets the render
    /// layer attach download progress to the right row.
    pub fn current_job(&self) -> Option<JobId> {
        self.current_job
    }

    /// Latest voice-download progress (`(bytes_done, bytes_total)`) for the
    /// current job, if any has been reported.
    pub fn download(&self) -> Option<(u64, u64)> {
        self.download
    }

    /// Whether a job thread is spawned — the render loop's repaint hint.
    pub fn is_busy(&self) -> bool {
        self.current_job.is_some()
    }

    /// Queue files as Convert jobs, in the order given — each stamped with
    /// `voice` (the picker's current default at enqueue time; the job's
    /// per-job override snapshot). Returns the issued [`JobId`]s. Invalid
    /// inputs are **not** filtered here — they fail in the job thread with
    /// the kernel's typed errors (e.g. the unsupported-extension list),
    /// surfacing as `Failed` rows.
    pub fn add_files(&mut self, paths: &[PathBuf], voice: &str) -> Vec<JobId> {
        paths
            .iter()
            .map(|input| {
                self.queue.push(JobKind::Convert {
                    input: input.clone(),
                    voice: voice.to_string(),
                })
            })
            .collect()
    }

    /// Queue `.taletrek` bundles as ReVoice jobs ("Add existing bundle…"):
    /// a full-bundle voice swap through the resynth path, written to
    /// `<stem>.<voice>.taletrek` so the input is never clobbered. Text-only
    /// bundles are accepted too (re-voice doubles as their synth path).
    pub fn add_bundles(&mut self, paths: &[PathBuf], voice: &str) -> Vec<JobId> {
        paths
            .iter()
            .map(|input| {
                self.queue.push(JobKind::ReVoice {
                    input: input.clone(),
                    voice: voice.to_string(),
                })
            })
            .collect()
    }

    /// Enqueue drag-dropped paths (T9): `.taletrek` → ReVoice, the CLI's
    /// source formats → Convert, everything else rejected with a visible
    /// reason. Paths already carrying a job (any state) are duplicates —
    /// deduped by path both within the batch and against the queue, so a
    /// drop can never double-queue a file. Returns the report the shell
    /// surfaces next to the queue.
    pub fn add_dropped(&mut self, paths: &[PathBuf], voice: &str) -> DropReport {
        let mut report = DropReport::default();
        let mut known: HashSet<PathBuf> = self
            .queue
            .jobs()
            .map(|job| input_of(&job.kind).to_path_buf())
            .collect();
        for path in paths {
            if !known.insert(path.clone()) {
                report.duplicates.push(path.clone());
                continue;
            }
            match classify_drop(path) {
                DropPlan::Convert(input) => {
                    self.queue.push(JobKind::Convert {
                        input,
                        voice: voice.to_string(),
                    });
                    report.enqueued += 1;
                }
                DropPlan::ReVoice(input) => {
                    self.queue.push(JobKind::ReVoice {
                        input,
                        voice: voice.to_string(),
                    });
                    report.enqueued += 1;
                }
                DropPlan::Reject { path, reason } => {
                    known.remove(&path);
                    report.rejected.push((path, reason));
                }
            }
        }
        report
    }

    /// User cancel (T9): marks the job `Cancelled` in the queue, and — for
    /// the running job — flips its cooperative flag so the thread unwinds
    /// at the next paragraph or stage boundary (see [module
    /// docs](self#cancellation-t9)). Cancelling a queued job just marks it;
    /// terminal states are queue no-ops.
    pub fn cancel(&mut self, id: JobId) {
        if self.current_job == Some(id) {
            if let Some(flag) = &self.current_cancel {
                flag.store(true, Ordering::Relaxed);
            }
        }
        self.queue.cancel(id);
    }

    /// User retry (T9): re-queue a `Failed`/`Cancelled` job (same input,
    /// same voice snapshot, same queue slot); the next [`Executor::pump`]
    /// spawns it fresh — new thread, new cancel flag.
    pub fn retry(&mut self, id: JobId) {
        self.queue.retry(id);
    }

    /// Apply every pending worker message to the queue (and render
    /// bookkeeping). Called once per frame before [`Executor::pump`].
    pub fn drain(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                WorkerMsg::Event(event) => self.queue.tick(event),
                WorkerMsg::Download { done, total } => self.download = Some((done, total)),
                WorkerMsg::Exited(id) => {
                    if self.current_job == Some(id) {
                        self.current_job = None;
                        self.current_cancel = None;
                        self.current_handle = None;
                        self.download = None;
                    }
                }
            }
        }
    }

    /// Start the next queued job if the executor is idle. Exactly one
    /// thread per job, sequential FIFO — parallelism lives *within* a job
    /// (the synth pool), per the execution model. `run` is the
    /// settings-derived snapshot (worker count, output dir) this spawn
    /// uses; a fresh [`CancelFlag`] is minted per spawn so a retried job
    /// never inherits a flipped flag.
    pub fn pump(&mut self, run: &RunConfig) {
        if self.current_job.is_some() {
            return;
        }
        let Some(job) = self.queue.next_job().cloned() else {
            return;
        };
        self.current_job = Some(job.id);
        self.download = None;
        let flag: CancelFlag = Arc::new(AtomicBool::new(false));
        self.current_cancel = Some(Arc::clone(&flag));
        self.current_handle = Some((self.spawn)(job, self.tx.clone(), flag, run.clone()));
    }

    /// Graceful shutdown: join the running job thread (waits for the job to
    /// finish — see [module docs](self)). Call from `App::on_exit`.
    pub fn shutdown(&mut self) {
        if let Some(handle) = self.current_handle.take() {
            let _ = handle.join();
        }
        self.current_job = None;
        self.current_cancel = None;
        self.download = None;
    }
}

/// What a dropped path becomes: a Convert job, a ReVoice job, or a
/// rejection carrying the reason the shell shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropPlan {
    /// A source document (or text-only bundle) → full `.taletrek`.
    Convert(PathBuf),
    /// A `.taletrek` bundle → re-voice it.
    ReVoice(PathBuf),
    /// Not a format the kernel ingests; `reason` is the visible sentence.
    Reject {
        /// The rejected path.
        path: PathBuf,
        /// Why (unsupported extension, no extension…).
        reason: String,
    },
}

/// The formats drag-drop accepts — exactly the CLI's set (`synth` +
/// `resynth`): every parseable source extension plus `.taletrek`.
const DROP_ACCEPTED: &str = ".taletrek, .epub, .txt, .html, .htm, .md, .markdown, .docx, .pdf";

/// Classify one dropped path (pure). Case-insensitive on the extension;
/// `.taletrek` routes to ReVoice, the CLI's source formats to Convert,
/// anything else (or no extension) is rejected with a reason naming what is
/// accepted.
#[must_use]
pub fn classify_drop(path: &Path) -> DropPlan {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return DropPlan::Reject {
            path: path.to_path_buf(),
            reason: format!("no file extension — accepted: {DROP_ACCEPTED}"),
        };
    };
    match ext.to_ascii_lowercase().as_str() {
        "taletrek" => DropPlan::ReVoice(path.to_path_buf()),
        "epub" | "txt" | "html" | "htm" | "md" | "markdown" | "docx" | "pdf" => {
            DropPlan::Convert(path.to_path_buf())
        }
        other => DropPlan::Reject {
            path: path.to_path_buf(),
            reason: format!("unsupported file type .{other} — accepted: {DROP_ACCEPTED}"),
        },
    }
}

/// What happened to a batch of dropped files — the shell renders this as a
/// visible summary (reject reasons included, per the drop-zone contract).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DropReport {
    /// Jobs queued (Convert + ReVoice).
    pub enqueued: usize,
    /// Paths skipped because a job for them already exists (or the batch
    /// contained them twice) — dedup by path.
    pub duplicates: Vec<PathBuf>,
    /// Rejected paths with the human reason for each.
    pub rejected: Vec<(PathBuf, String)>,
}

/// The input path of a job kind — both kinds carry one.
fn input_of(kind: &JobKind) -> &Path {
    match kind {
        JobKind::Convert { input, .. } | JobKind::ReVoice { input, .. } => input,
    }
}

/// The production spawner: one OS thread per job, reporting the outcome via
/// [`execute_and_report`].
fn spawn_job_thread(
    job: Job,
    tx: Sender<WorkerMsg>,
    flag: CancelFlag,
    run: RunConfig,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let id = job.id;
        execute_and_report(id, &tx, || run_job_by_kind(id, &job.kind, &tx, &flag, &run));
    })
}

/// A [`PiperRunner`] decorator that refuses to infer once its [`CancelFlag`]
/// is set: `predict` returns [`SynthError::Cancelled`] *before* touching the
/// inner runner, so rayon's abort-on-first-error unwinds the synth pool at
/// the next paragraph boundary (the per-paragraph cancel granularity — see
/// [module docs](self#cancellation-t9)). Every production factory installs
/// one around the engine runner.
struct CancellableRunner<R> {
    /// The job's cooperative cancel flag (shared with the executor).
    flag: CancelFlag,
    /// The engine runner (native sherpa; subprocess under a CLI-style
    /// override).
    inner: R,
}

impl<R> CancellableRunner<R> {
    /// Wrap `inner` with the job's cancel flag.
    fn new(flag: CancelFlag, inner: R) -> Self {
        Self { flag, inner }
    }
}

impl<R: PiperRunner> PiperRunner for CancellableRunner<R> {
    fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
        if self.flag.load(Ordering::Relaxed) {
            return Err(SynthError::Cancelled);
        }
        self.inner.predict(voice_model, text)
    }
}

/// Stage-boundary cancel check (after load, after the voice resolve, and
/// critically before the bundle write). Raises the typed
/// [`SynthError::Cancelled`] as an `anyhow` error so `?` propagates it.
fn ensure_not_cancelled(flag: &CancelFlag) -> Result<()> {
    if flag.load(Ordering::Relaxed) {
        return Err(anyhow::Error::new(SynthError::Cancelled));
    }
    Ok(())
}

/// Map an `anyhow` job error to one human sentence for the `Failed` row.
///
/// Walks the error's chain and matches the **first** typed kernel error it
/// knows: the typed variants exist for exactly this surfacing (piper-missing
/// vs predict vs empty-text vs corrupt-container…). Unknown chains keep
/// their full context-first rendering — nothing is swallowed, only
/// re-phrased.
fn humanize_error(err: &anyhow::Error) -> String {
    for cause in err.chain() {
        if let Some(e) = cause.downcast_ref::<SynthError>() {
            return humanize_synth(e);
        }
        if let Some(e) = cause.downcast_ref::<taletrek_parse::ParseError>() {
            return match e {
                taletrek_parse::ParseError::UnsupportedFormat(format) => {
                    format!("TaleTrek can't read {format} files yet.")
                }
                taletrek_parse::ParseError::Malformed { format, detail } => {
                    format!("The {format} file is malformed: {detail}")
                }
            };
        }
        if cause
            .downcast_ref::<crate::UnsupportedExtensionError>()
            .is_some()
        {
            return format!("Not a supported input format — accepted: {DROP_ACCEPTED}");
        }
        if let Some(e) = cause.downcast_ref::<FullInputError>() {
            return format!(
                "This bundle already contains audio (voice {}) — re-voice it instead \
                 (Add existing bundle…).",
                e.voice
            );
        }
        if let Some(taletrek_synth::BundleError::UnknownSchema { found, supported }) =
            cause.downcast_ref::<taletrek_synth::BundleError>()
        {
            return format!(
                "This bundle was written by a newer TaleTrek (schema v{found}, this app \
                 reads v{supported}) — update TaleTrek."
            );
        }
    }
    format!("{err:#}")
}

/// The [`SynthError`] sentences — one per typed variant.
fn humanize_synth(e: &SynthError) -> String {
    match e {
        SynthError::PiperMissing { bin, .. } => format!(
            "The piper speech engine {bin:?} could not be started — install piper on PATH, \
             or use the built-in engine."
        ),
        SynthError::Predict { stderr, .. } => format!(
            "The speech engine failed on a paragraph: {}",
            truncate(stderr, 200)
        ),
        SynthError::EmptyOutput { chunk } => {
            format!(
                "The speech engine produced no audio for: {}",
                truncate(chunk, 80)
            )
        }
        SynthError::VoiceLoad { path, reason } => format!(
            "The voice model {} could not be loaded ({reason}) — delete it from the voice \
             cache to force a re-download.",
            path.display()
        ),
        SynthError::EncoderMissing { bin, .. } => {
            format!("The audio encoder {bin:?} could not be started.")
        }
        SynthError::EncoderIo(_) => "The audio encoder failed while converting.".to_string(),
        SynthError::EncoderFailed { stderr, .. } => {
            format!("The audio encoder failed: {}", truncate(stderr, 200))
        }
        SynthError::NativeEncode { reason } => {
            format!("Encoding the audio failed: {reason}")
        }
        SynthError::EmptyText => "A paragraph had no speakable text after cleanup.".to_string(),
        SynthError::Cancelled => "Cancelled.".to_string(),
    }
}

/// First `max` chars of `text` with an ellipsis when truncated — error
/// surfaces stay one line.
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.trim().to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Run `job_body`, then report its outcome as the job's final events:
/// `Finished` (with the written bundle's path), `Failed` (the error mapped
/// to one human sentence via [`humanize_error`]), or `Failed` on a panic (a
/// panicking job must not deadlock the queue). Always sends
/// [`WorkerMsg::Exited`] last — the executor's next-job admission depends
/// on it. A `Failed` for an already-`Cancelled` row no-ops in the queue
/// (the cancel raced the thread's exit).
fn execute_and_report(
    id: JobId,
    tx: &Sender<WorkerMsg>,
    job_body: impl FnOnce() -> Result<PathBuf>,
) {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(job_body)) {
        Ok(Ok(out)) => {
            let _ = tx.send(WorkerMsg::Event(QueueEvent::Finished { id, out }));
        }
        Ok(Err(err)) => {
            let _ = tx.send(WorkerMsg::Event(QueueEvent::Failed {
                id,
                message: humanize_error(&err),
            }));
        }
        Err(payload) => {
            let _ = tx.send(WorkerMsg::Event(QueueEvent::Failed {
                id,
                message: panic_message(payload),
            }));
        }
    }
    let _ = tx.send(WorkerMsg::Exited(id));
}

/// Render a panic payload as a human-readable message (`&str` / `String`
/// payloads keep their text; anything else degrades to a generic label).
fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        format!("internal error (panic): {text}")
    } else if let Some(text) = payload.downcast_ref::<String>() {
        format!("internal error (panic): {text}")
    } else {
        "internal error (panic)".to_string()
    }
}

/// Dispatch a job by kind to its pipeline: Convert (source document or
/// text-only bundle → full bundle) or ReVoice (any bundle → re-voiced
/// bundle, the voice picker's "Add existing bundle…" action).
fn run_job_by_kind(
    id: JobId,
    kind: &JobKind,
    tx: &Sender<WorkerMsg>,
    flag: &CancelFlag,
    run: &RunConfig,
) -> Result<PathBuf> {
    match kind {
        JobKind::Convert { input, voice } => run_convert_job(id, input, voice, tx, flag, run),
        JobKind::ReVoice { input, voice } => run_revoice_job(id, input, voice, tx, flag, run),
    }
}

/// The production voice-model resolver shared by both job kinds: curated id
/// → cache or blocking download (progress forwarded through the sink as
/// [`WorkerMsg::Download`]s). Boxed so Convert and ReVoice can share one
/// closure over the per-job sink.
fn resolve_curated<'a>(
    id: JobId,
    voice: &'a str,
    tx: &Sender<WorkerMsg>,
) -> Box<dyn Fn() -> Result<PathBuf> + 'a> {
    let sink = ChannelSink::new(tx.clone(), id);
    Box::new(move || {
        let cache_dir =
            default_cache_dir().context("no platform cache directory discovered (set $HOME)")?;
        let opts = ResolveOpts::new(None, cache_dir);
        resolve_voice(
            Some(voice),
            &opts,
            &UreqVoiceSource,
            Some(&sink as &dyn taletrek_worker::ProgressSink),
        )
        .context("resolving voice model")
    })
}

/// The Convert pipeline with the production seams: the native engines (T5
/// defaults) wrapped in [`CancellableRunner`] (per-paragraph cancel), the
/// real voice resolver (curated catalog → cache or blocking download,
/// progress forwarded through the sink), and the settings-derived run
/// tuning (worker count, output dir).
fn run_convert_job(
    id: JobId,
    input: &Path,
    voice: &str,
    tx: &Sender<WorkerMsg>,
    flag: &CancelFlag,
    run: &RunConfig,
) -> Result<PathBuf> {
    let factory_flag = Arc::clone(flag);
    run_convert_job_with(
        id,
        input,
        voice,
        tx,
        &resolve_curated(id, voice, tx),
        move |voice_model| {
            CancellableRunner::new(
                Arc::clone(&factory_flag),
                DesktopRunner::new(spec_for_gui(), voice_model),
            )
        },
        &encoder_for_gui()?,
        flag,
        run,
    )
}

/// Select the native runner spec (the GUI's fixed engine choice).
fn spec_for_gui() -> RunnerSpec {
    RunnerSpec::select(None).expect("GUI builds carry the native engine features")
}

/// Select the native encoder (the GUI's fixed encoder choice).
fn encoder_for_gui() -> Result<DesktopEncoder> {
    DesktopEncoder::select(None)
}

/// The Convert job core with every engine seam injectable — the injectable
/// counterpart of the CLI's `run_synth_with`. Steps:
///
/// 1. parse-or-load the input (source document → in-memory text-only bundle;
///    `.taletrek` → read) and refuse already-full input (the re-voice path
///    exists for that),
/// 2. report `Started` with the total paragraph count (progress baseline),
/// 3. resolve the voice model via `resolve_voice_model` (production: curated
///    id → cache or download, progress → [`WorkerMsg::Download`]),
/// 4. synthesize every paragraph in parallel through the injected runner
///    factory + encoder (progress → [`QueueEvent::Progress`]) **streaming
///    straight into the output's same-dir temp** — segments never
///    accumulate in memory (the streaming-synth bound),
/// 5. rename the completed bundle into place beside the input
///    (`<stem>.synth.taletrek` — the CLI naming rule) or into
///    `run.output_dir` under the same name.
///
/// The cancel `flag` is checked at every stage boundary and — via whatever
/// [`CancellableRunner`] the factory installs — between paragraphs; a
/// cancelled run fails with the typed [`SynthError::Cancelled`] and the
/// streaming temp is removed — never a partial book. Returns the written
/// output path; the caller ([`execute_and_report`]) turns `Ok`/`Err` into
/// `Finished`/`Failed` events.
#[allow(clippy::too_many_arguments)] // mirrors the CLI's `run_synth_with` seam set (identity + channel + flag/tuning + three injectables); grouping would hide the test seams.
fn run_convert_job_with<R, E, F>(
    id: JobId,
    input: &Path,
    voice: &str,
    tx: &Sender<WorkerMsg>,
    resolve_voice_model: &dyn Fn() -> Result<PathBuf>,
    make_runner_of: F,
    encoder: &E,
    flag: &CancelFlag,
    run: &RunConfig,
) -> Result<PathBuf>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn(&Path) -> R + Sync,
{
    let mut bundle = crate::load_synth_input(input, voice)?;
    refuse_full_input(&bundle, input)?;
    ensure_not_cancelled(flag)?;

    let total = paragraph_count(&bundle);
    let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total }));

    let sink = ChannelSink::new(tx.clone(), id);
    let voice_model = resolve_voice_model()?;
    ensure_not_cancelled(flag)?;

    // Streaming synth + stamp + atomic write (the streaming-synth memory
    // bound): output resolution and its directory move BEFORE synthesis —
    // the wrapper opens the same-dir temp first, then every finished segment
    // flows into it (bundle.audio never accumulates).
    let output = resolve_output(default_synth_output(input), run.output_dir.as_deref());
    if let Some(dir) = &run.output_dir {
        fs::create_dir_all(dir)
            .with_context(|| format!("creating output directory {}", dir.display()))?;
    }
    let factory_model = voice_model.clone();
    synth_stamp_to_file(
        &mut bundle,
        voice,
        &voice_model,
        move || make_runner_of(&factory_model),
        encoder,
        run.jobs,
        Some(&sink),
        &output,
    )
    .with_context(|| format!("writing output bundle {}", output.display()))?;
    Ok(output)
}

/// Total paragraphs across every chapter — the progress denominator (the
/// synth pool's own `total`; dedup may store fewer segments).
fn paragraph_count(bundle: &BookBundle) -> usize {
    bundle.chapters.iter().map(|ch| ch.paragraphs.len()).sum()
}

/// The ReVoice pipeline with the production seams — the GUI counterpart of
/// the CLI's `run_resynth`: resolve the new voice, re-synth every paragraph
/// under it (stale audio replaced, not merged), and write the re-voiced
/// bundle as `<stem>.<voice>.taletrek` (beside the input, or into the
/// configured output dir).
fn run_revoice_job(
    id: JobId,
    input: &Path,
    voice: &str,
    tx: &Sender<WorkerMsg>,
    flag: &CancelFlag,
    run: &RunConfig,
) -> Result<PathBuf> {
    let factory_flag = Arc::clone(flag);
    run_revoice_job_with(
        id,
        input,
        voice,
        tx,
        &resolve_curated(id, voice, tx),
        move |voice_model| {
            CancellableRunner::new(
                Arc::clone(&factory_flag),
                DesktopRunner::new(spec_for_gui(), voice_model),
            )
        },
        &encoder_for_gui()?,
        flag,
        run,
    )
}

/// The ReVoice job core with every engine seam injectable — the injectable
/// counterpart of the CLI's `run_resynth`. Steps:
///
/// 1. read the input as a bundle (unlike Convert, a full bundle is the
///    *primary* input; a text-only one works too),
/// 2. report `Started` with the total paragraph count,
/// 3. resolve the new voice model (production: curated id → cache or
///    download, progress → [`WorkerMsg::Download`]),
/// 4. re-voice via `resynth_and_stamp` — the manifest's `voiceId` is
///    rewritten and every paragraph re-synthesized under the new voice
///    (progress → [`QueueEvent::Progress`]),
/// 5. write the bundle as `<stem>.<voice>.taletrek` ([`default_resynth_output`])
///    — never clobbering the input.
///
/// Cancel checks mirror Convert: stage boundaries + the factory's
/// [`CancellableRunner`], with the pre-write guard ensuring a cancelled
/// re-voice writes nothing.
#[allow(clippy::too_many_arguments)] // mirrors `run_convert_job_with`'s seam set (identity + channel + flag/tuning + three injectables)
fn run_revoice_job_with<R, E, F>(
    id: JobId,
    input: &Path,
    voice: &str,
    tx: &Sender<WorkerMsg>,
    resolve_voice_model: &dyn Fn() -> Result<PathBuf>,
    make_runner_of: F,
    encoder: &E,
    flag: &CancelFlag,
    run: &RunConfig,
) -> Result<PathBuf>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn(&Path) -> R + Sync,
{
    let input_bytes =
        fs::read(input).with_context(|| format!("reading input bundle {}", input.display()))?;
    let mut bundle = read_book_bundle(&input_bytes)?;
    ensure_not_cancelled(flag)?;

    let total = paragraph_count(&bundle);
    let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total }));

    let sink = ChannelSink::new(tx.clone(), id);
    let voice_model = resolve_voice_model()?;
    ensure_not_cancelled(flag)?;

    let factory_model = voice_model.clone();
    resynth_and_stamp(
        &mut bundle,
        voice,
        &voice_model,
        move || make_runner_of(&factory_model),
        encoder,
        run.jobs,
        Some(&sink),
    )?;
    ensure_not_cancelled(flag)?;

    let output = resolve_output(
        default_resynth_output(input, voice),
        run.output_dir.as_deref(),
    );
    if let Some(dir) = &run.output_dir {
        fs::create_dir_all(dir)
            .with_context(|| format!("creating output directory {}", dir.display()))?;
    }
    write_book_bundle_file(&bundle, &output)
        .with_context(|| format!("writing output bundle {}", output.display()))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use crossbeam_channel::unbounded;

    use taletrek_synth::synth::SynthError;
    use taletrek_synth::{read_book_bundle, AudioCodec, WavPassthrough};

    use taletrek_worker::DEFAULT_VOICE_ID;

    use crate::cli::ParseArgs;
    use crate::gui::queue::JobState;

    /// Canonical mono 16-bit 16 kHz WAV wrapping `pcm` — the shape Piper
    /// emits on stdout. Mirrors the stubs in `main.rs`/`bundle_io.rs` tests
    /// so these stay self-contained.
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
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    fn write_input(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    /// A cancel flag that never flips — tests that don't exercise cancel.
    fn flag_off() -> CancelFlag {
        Arc::new(std::sync::atomic::AtomicBool::new(false))
    }

    /// A run config writing beside the input with `jobs` workers.
    fn plain_run(jobs: usize) -> RunConfig {
        RunConfig {
            jobs,
            output_dir: None,
        }
    }

    /// Drain `ex` until `cond` holds, or fail after ~5s (a hung job thread
    /// must fail the test, not hang it).
    fn wait_until(ex: &mut Executor, cond: impl Fn(&Executor) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            ex.drain();
            if cond(ex) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "condition not met within 5s — job thread stalled"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Like [`wait_until`], but also pump each round — for assertions about
    /// the *next* job, which needs spawning after the current one exits.
    fn pump_until(ex: &mut Executor, cond: impl Fn(&Executor) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            ex.drain();
            if cond(ex) {
                return;
            }
            ex.pump(&RunConfig::default());
            assert!(
                Instant::now() < deadline,
                "condition not met within 5s — job thread stalled"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    // ---- Executor: add_files / add_bundles / pump / drain ----

    #[test]
    fn add_files_queues_convert_jobs_in_order_with_the_given_voice() {
        let mut ex =
            Executor::with_spawner(Box::new(|_job, _tx, _flag, _run| thread::spawn(|| {})));
        let ids = ex.add_files(
            &[PathBuf::from("a.txt"), PathBuf::from("b.epub")],
            DEFAULT_VOICE_ID,
        );

        let jobs: Vec<_> = ex.queue().jobs().collect();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs.iter().map(|j| j.id).collect::<Vec<_>>(), ids);
        for (job, input) in jobs.iter().zip(["a.txt", "b.epub"]) {
            assert_eq!(
                job.kind,
                JobKind::Convert {
                    input: PathBuf::from(input),
                    voice: DEFAULT_VOICE_ID.to_string()
                }
            );
            assert_eq!(job.state, JobState::Queued);
        }
    }

    #[test]
    fn add_files_honors_a_non_default_voice_per_job() {
        // The voice picker's selection flows into every queued job — the
        // per-job override snapshot taken at enqueue time.
        let mut ex =
            Executor::with_spawner(Box::new(|_job, _tx, _flag, _run| thread::spawn(|| {})));
        ex.add_files(&[PathBuf::from("a.txt")], "en_GB-alan-medium");

        let job = ex.queue().jobs().next().unwrap();
        assert_eq!(
            job.kind,
            JobKind::Convert {
                input: PathBuf::from("a.txt"),
                voice: "en_GB-alan-medium".to_string()
            }
        );
    }

    #[test]
    fn add_bundles_queues_revoice_jobs_with_the_given_voice() {
        let mut ex =
            Executor::with_spawner(Box::new(|_job, _tx, _flag, _run| thread::spawn(|| {})));
        let ids = ex.add_bundles(
            &[
                PathBuf::from("a.synth.taletrek"),
                PathBuf::from("b.taletrek"),
            ],
            "en_GB-cori-medium",
        );

        let jobs: Vec<_> = ex.queue().jobs().collect();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs.iter().map(|j| j.id).collect::<Vec<_>>(), ids);
        for (job, input) in jobs.iter().zip(["a.synth.taletrek", "b.taletrek"]) {
            assert_eq!(
                job.kind,
                JobKind::ReVoice {
                    input: PathBuf::from(input),
                    voice: "en_GB-cori-medium".to_string()
                }
            );
            assert_eq!(job.state, JobState::Queued);
        }
    }

    #[test]
    fn pump_spawns_exactly_one_thread_per_job_before_started_drains() {
        // A spawner whose threads never report Exited: the executor must
        // still refuse to double-spawn across frames (the pre-Started gap).
        let spawns = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&spawns);
        let mut ex = Executor::with_spawner(Box::new(move |_job, _tx, _flag, _run| {
            counter.fetch_add(1, Ordering::SeqCst);
            thread::spawn(|| {})
        }));
        ex.add_files(&[PathBuf::from("a.txt")], DEFAULT_VOICE_ID);

        ex.pump(&RunConfig::default());
        ex.pump(&RunConfig::default());
        ex.drain();
        ex.pump(&RunConfig::default());
        assert_eq!(spawns.load(Ordering::SeqCst), 1, "one spawn per job");
        assert!(ex.current_job().is_some());
        assert!(ex.is_busy());
    }

    #[test]
    fn jobs_run_sequentially_and_events_reach_the_queue() {
        // Scripted threads: Started → Progress → Finished → Exited.
        let mut ex = Executor::with_spawner(Box::new(|job, tx, _flag, _run| {
            thread::spawn(move || {
                let id = job.id;
                let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total: 2 }));
                let _ = tx.send(WorkerMsg::Event(QueueEvent::Progress { id, done: 1 }));
                let _ = tx.send(WorkerMsg::Event(QueueEvent::Finished {
                    id,
                    out: PathBuf::from("out.taletrek"),
                }));
                let _ = tx.send(WorkerMsg::Exited(id));
            })
        }));
        let ids = ex.add_files(
            &[PathBuf::from("a.txt"), PathBuf::from("b.txt")],
            DEFAULT_VOICE_ID,
        );

        ex.pump(&RunConfig::default());
        // a finishes; b must still be Queued until then.
        wait_until(&mut ex, |ex| {
            matches!(ex.queue().get(ids[0]).unwrap().state, JobState::Done(_))
        });
        assert_eq!(
            ex.queue().get(ids[1]).unwrap().state,
            JobState::Queued,
            "second job waits while the first runs"
        );

        ex.pump(&RunConfig::default());
        wait_until(&mut ex, |ex| {
            matches!(ex.queue().get(ids[1]).unwrap().state, JobState::Done(_))
        });
        assert!(!ex.is_busy(), "idle after both jobs");
    }

    #[test]
    fn drain_tracks_download_and_exited_clears_bookkeeping() {
        // Capture the spawner's tx so the test can act as a "worker".
        let captured: Arc<Mutex<Option<Sender<WorkerMsg>>>> = Arc::new(Mutex::new(None));
        let slot = Arc::clone(&captured);
        let mut ex = Executor::with_spawner(Box::new(move |_job, tx, _flag, _run| {
            *slot.lock().unwrap() = Some(tx.clone());
            thread::spawn(|| {})
        }));
        let ids = ex.add_files(&[PathBuf::from("a.txt")], DEFAULT_VOICE_ID);
        ex.pump(&RunConfig::default());
        let tx = captured.lock().unwrap().clone().unwrap();

        tx.send(WorkerMsg::Download {
            done: 1024,
            total: 4096,
        })
        .unwrap();
        ex.drain();
        assert_eq!(ex.download(), Some((1024, 4096)));

        // A Finished for a job that never Started is a queue no-op (T6
        // defense) — surfaced here through the executor's own drain path.
        tx.send(WorkerMsg::Event(QueueEvent::Finished {
            id: ids[0],
            out: PathBuf::from("ghost.taletrek"),
        }))
        .unwrap();
        ex.drain();
        assert_eq!(ex.queue().get(ids[0]).unwrap().state, JobState::Queued);

        // A pre-Started failure lands on the Queued job (else the executor
        // would respawn it forever); Exited then clears bookkeeping.
        tx.send(WorkerMsg::Event(QueueEvent::Failed {
            id: ids[0],
            message: "reading source document".to_string(),
        }))
        .unwrap();
        tx.send(WorkerMsg::Exited(ids[0])).unwrap();
        ex.drain();
        assert_eq!(ex.current_job(), None);
        assert_eq!(ex.download(), None);
        assert!(matches!(
            ex.queue().get(ids[0]).unwrap().state,
            JobState::Failed(_)
        ));

        // The failed job is skipped; a ghost Exited (unknown job) must not
        // clear the next real current job.
        let ids2 = ex.add_files(&[PathBuf::from("b.txt")], DEFAULT_VOICE_ID);
        ex.pump(&RunConfig::default());
        tx.send(WorkerMsg::Exited(JobId::for_test(999))).unwrap();
        ex.drain();
        assert_eq!(
            ex.current_job(),
            Some(ids2[0]),
            "ghost Exited changes nothing"
        );
        ex.shutdown();
    }

    // ---- cancel (T9) ----

    #[test]
    fn cancel_of_the_running_job_flips_the_cooperative_flag_and_advances_the_queue() {
        // The slow job's thread cooperates: it reports progress until the
        // cancel flag flips, then exits WITHOUT Finished (a cancelled run
        // never writes). The queued follower must then run to completion.
        let mut ex = Executor::with_spawner(Box::new(|job, tx, flag, _run| {
            thread::spawn(move || {
                let id = job.id;
                let input = match &job.kind {
                    JobKind::Convert { input, .. } | JobKind::ReVoice { input, .. } => {
                        input.clone()
                    }
                };
                if input.file_name().map(|n| n.to_string_lossy()) == Some("slow.txt".into()) {
                    let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total: 100 }));
                    while !flag.load(Ordering::Relaxed) {
                        let _ = tx.send(WorkerMsg::Event(QueueEvent::Progress { id, done: 1 }));
                        std::thread::sleep(Duration::from_millis(1));
                    }
                } else {
                    let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total: 1 }));
                    let _ = tx.send(WorkerMsg::Event(QueueEvent::Finished {
                        id,
                        out: PathBuf::from("next.synth.taletrek"),
                    }));
                }
                let _ = tx.send(WorkerMsg::Exited(id));
            })
        }));
        let ids = ex.add_files(
            &[PathBuf::from("slow.txt"), PathBuf::from("next.txt")],
            DEFAULT_VOICE_ID,
        );
        ex.pump(&RunConfig::default());
        wait_until(&mut ex, |ex| {
            matches!(
                ex.queue().get(ids[0]).unwrap().state,
                JobState::Running { .. }
            )
        });

        ex.cancel(ids[0]);
        assert_eq!(
            ex.queue().get(ids[0]).unwrap().state,
            JobState::Cancelled,
            "cancel applies to the queue immediately"
        );

        pump_until(&mut ex, |ex| {
            matches!(ex.queue().get(ids[1]).unwrap().state, JobState::Done(_))
        });
        assert_eq!(
            ex.queue().get(ids[0]).unwrap().state,
            JobState::Cancelled,
            "the cancelled job stays cancelled — its Exited admits the follower"
        );
        assert!(!ex.is_busy());
    }

    #[test]
    fn cancel_of_a_queued_job_marks_it_cancelled_and_never_spawns_it() {
        let spawns = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&spawns);
        let mut ex = Executor::with_spawner(Box::new(move |job, tx, _flag, _run| {
            counter.fetch_add(1, Ordering::SeqCst);
            thread::spawn(move || {
                let id = job.id;
                let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total: 1 }));
                let _ = tx.send(WorkerMsg::Event(QueueEvent::Finished {
                    id,
                    out: PathBuf::from("out.taletrek"),
                }));
                let _ = tx.send(WorkerMsg::Exited(id));
            })
        }));
        let ids = ex.add_files(
            &[PathBuf::from("a.txt"), PathBuf::from("b.txt")],
            DEFAULT_VOICE_ID,
        );
        ex.pump(&RunConfig::default());
        ex.cancel(ids[1]); // still Queued — no thread to signal
        wait_until(&mut ex, |ex| {
            matches!(ex.queue().get(ids[0]).unwrap().state, JobState::Done(_))
        });

        ex.pump(&RunConfig::default());
        wait_until(&mut ex, |ex| !ex.is_busy());
        assert_eq!(
            ex.queue().get(ids[1]).unwrap().state,
            JobState::Cancelled,
            "a cancelled queued job is never spawned"
        );
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
    }

    // ---- retry (T9) ----

    #[test]
    fn retry_of_a_failed_job_requeues_it_and_the_executor_reruns_it() {
        // Script a job that fails on its first execution and succeeds on the
        // retry — keyed by job id, so the retry replays the same job.
        let failed_once: Arc<Mutex<Vec<JobId>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&failed_once);
        let mut ex = Executor::with_spawner(Box::new(move |job, tx, _flag, _run| {
            let seen = Arc::clone(&seen);
            thread::spawn(move || {
                let id = job.id;
                let first_run = {
                    let mut seen = seen.lock().unwrap();
                    if seen.contains(&id) {
                        false
                    } else {
                        seen.push(id);
                        true
                    }
                };
                if first_run {
                    let _ = tx.send(WorkerMsg::Event(QueueEvent::Failed {
                        id,
                        message: "malformed epub source: bad zip".to_string(),
                    }));
                } else {
                    let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total: 1 }));
                    let _ = tx.send(WorkerMsg::Event(QueueEvent::Finished {
                        id,
                        out: PathBuf::from("broke.synth.taletrek"),
                    }));
                }
                let _ = tx.send(WorkerMsg::Exited(id));
            })
        }));
        let ids = ex.add_files(&[PathBuf::from("broke.epub")], DEFAULT_VOICE_ID);
        ex.pump(&RunConfig::default());
        wait_until(&mut ex, |ex| {
            matches!(ex.queue().get(ids[0]).unwrap().state, JobState::Failed(_))
        });

        ex.retry(ids[0]);
        assert_eq!(ex.queue().get(ids[0]).unwrap().state, JobState::Queued);
        ex.pump(&RunConfig::default());
        wait_until(&mut ex, |ex| {
            matches!(ex.queue().get(ids[0]).unwrap().state, JobState::Done(_))
        });
    }

    // ---- CancellableRunner (T9) ----

    #[test]
    fn cancellable_runner_short_circuits_without_calling_inner_when_the_flag_is_set() {
        let calls = Arc::new(AtomicUsize::new(0));
        let inner = CountingRunner(Arc::clone(&calls));
        let flag: CancelFlag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        flag.store(true, Ordering::Relaxed);

        let mut runner = CancellableRunner::new(Arc::clone(&flag), inner);
        let err = runner
            .predict(Path::new("/dev/null"), "hello")
            .expect_err("a set flag must abort before inference");
        assert!(matches!(err, SynthError::Cancelled));
        assert_eq!(calls.load(Ordering::Relaxed), 0, "inner never runs");

        // Clearing the flag restores pass-through inference.
        flag.store(false, Ordering::Relaxed);
        let out = runner.predict(Path::new("/dev/null"), "hello").unwrap();
        assert_eq!(out, canonical_wav(&[0x01, 0x02, 0x03, 0x04]));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    /// A runner that counts its predict calls and returns the canonical WAV.
    struct CountingRunner(Arc<AtomicUsize>);

    impl PiperRunner for CountingRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    #[test]
    fn convert_job_core_cancelled_mid_run_writes_no_bundle() {
        // The resolver flips the flag after Started (i.e. mid-download /
        // between stages); the wrapped runner must then short-circuit rayon
        // with SynthError::Cancelled and the output file must never appear.
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "fable.txt", "One paragraph.\n\nTwo paragraph.");
        let flag: CancelFlag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let resolver_flag = Arc::clone(&flag);
        let runner_flag = Arc::clone(&flag);
        let (tx, rx) = unbounded();

        let err = run_convert_job_with(
            JobId::for_test(1),
            &input,
            DEFAULT_VOICE_ID,
            &tx,
            &move || {
                resolver_flag.store(true, Ordering::Relaxed);
                Ok(PathBuf::from("/dev/null"))
            },
            move |_voice_model| CancellableRunner::new(Arc::clone(&runner_flag), StubRunner),
            &WavPassthrough,
            &flag,
            &plain_run(1),
        )
        .expect_err("a cancelled run must fail, not write");

        assert!(
            err.chain().any(|c| {
                c.downcast_ref::<SynthError>()
                    .is_some_and(|s| matches!(s, SynthError::Cancelled))
            }),
            "typed Cancelled in the chain: {err:#}"
        );
        assert!(
            !dir.path().join("fable.synth.taletrek").exists(),
            "no half-written bundle"
        );
        assert!(
            rx.try_recv().is_ok(),
            "Started was reported before the cancel landed"
        );
    }

    #[test]
    fn convert_job_core_checks_the_flag_before_writing_even_if_synth_missed_it() {
        // Defense-in-depth for the pre-write boundary: the flag flips during
        // voice resolution but the (injected) runner ignores it — the job
        // must still refuse to write the bundle.
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "fable.txt", "One paragraph.");
        let flag: CancelFlag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let set_flag = Arc::clone(&flag);
        let (tx, _rx) = unbounded();

        let err = run_convert_job_with(
            JobId::for_test(1),
            &input,
            DEFAULT_VOICE_ID,
            &tx,
            &move || {
                set_flag.store(true, Ordering::Relaxed);
                Ok(PathBuf::from("/dev/null"))
            },
            |_| StubRunner,
            &WavPassthrough,
            &flag,
            &plain_run(1),
        )
        .expect_err("the pre-write check must abort");

        assert!(
            err.chain().any(|c| {
                c.downcast_ref::<SynthError>()
                    .is_some_and(|s| matches!(s, SynthError::Cancelled))
            }),
            "typed Cancelled in the chain: {err:#}"
        );
        assert!(!dir.path().join("fable.synth.taletrek").exists());
    }

    #[test]
    fn convert_job_core_writes_into_the_configured_output_dir() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "fable.txt", "One paragraph.");
        let out_dir = dir.path().join("audiobooks");
        let (tx, _rx) = unbounded();

        let out = run_convert_job_with(
            JobId::for_test(1),
            &input,
            DEFAULT_VOICE_ID,
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &RunConfig {
                jobs: 1,
                output_dir: Some(out_dir.clone()),
            },
        )
        .expect("convert with an output dir should succeed");

        assert_eq!(out, out_dir.join("fable.synth.taletrek"));
        assert!(out.is_file(), "the configured dir is created + used");
        assert!(
            !dir.path().join("fable.synth.taletrek").exists(),
            "nothing spills beside the input"
        );
    }

    // ---- humanize_error (T9) ----

    #[test]
    fn humanize_error_maps_typed_variants_to_human_sentences() {
        let piper_missing = anyhow::Error::new(SynthError::PiperMissing {
            bin: "piper".into(),
            source: std::io::Error::from_raw_os_error(2),
        })
        .context("resolving voice model");
        assert!(
            humanize_error(&piper_missing)
                .to_lowercase()
                .contains("piper"),
            "names the engine"
        );

        let empty_text = anyhow::Error::new(SynthError::EmptyText);
        assert!(
            humanize_error(&empty_text)
                .to_lowercase()
                .contains("no speakable text"),
            "explains empty text"
        );

        let malformed = anyhow::Error::new(taletrek_parse::ParseError::Malformed {
            format: taletrek_parse::SourceFormat::Epub,
            detail: "bad zip".into(),
        });
        let msg = humanize_error(&malformed).to_lowercase();
        assert!(
            msg.contains("epub") && msg.contains("bad zip"),
            "names the format + detail: {msg}"
        );

        let unsupported = anyhow::Error::new(crate::UnsupportedExtensionError {
            path: PathBuf::from("book.mobi"),
        });
        assert!(
            humanize_error(&unsupported).contains("accepted"),
            "lists what is accepted"
        );

        let full_input = anyhow::Error::new(crate::bundle_io::FullInputError {
            input: "book.taletrek".into(),
            voice: "en_US-ryan-medium".into(),
        });
        assert!(
            humanize_error(&full_input).contains("re-voice"),
            "points at the re-voice action"
        );
    }

    #[test]
    fn humanize_error_falls_back_to_the_chained_message() {
        // An error with no typed variant known to the GUI keeps its anyhow
        // chain — context first, root cause last, nothing swallowed.
        let err = anyhow::Error::new(std::io::Error::other("disk full"))
            .context("writing output bundle out.taletrek");
        let msg = humanize_error(&err);
        assert!(
            msg.contains("writing output bundle") && msg.contains("disk full"),
            "chain preserved: {msg}"
        );
    }

    // ---- drag-drop classification (T9) ----

    #[test]
    fn add_dropped_routes_formats_and_rejects_others_with_a_reason() {
        let mut ex =
            Executor::with_spawner(Box::new(|_job, _tx, _flag, _run| thread::spawn(|| {})));
        let report = ex.add_dropped(
            &[
                PathBuf::from("/books/a.epub"),
                PathBuf::from("/books/b.taletrek"),
                PathBuf::from("/books/c.png"),
            ],
            DEFAULT_VOICE_ID,
        );

        assert_eq!(report.enqueued, 2);
        assert_eq!(report.rejected.len(), 1);
        assert_eq!(report.rejected[0].0, PathBuf::from("/books/c.png"));
        assert!(
            report.rejected[0].1.to_lowercase().contains("unsupported"),
            "the rejection carries a visible reason: {}",
            report.rejected[0].1
        );

        let jobs: Vec<_> = ex.queue().jobs().collect();
        assert_eq!(jobs.len(), 2);
        assert_eq!(
            jobs[0].kind,
            JobKind::Convert {
                input: PathBuf::from("/books/a.epub"),
                voice: DEFAULT_VOICE_ID.to_string()
            }
        );
        assert_eq!(
            jobs[1].kind,
            JobKind::ReVoice {
                input: PathBuf::from("/books/b.taletrek"),
                voice: DEFAULT_VOICE_ID.to_string()
            }
        );
    }

    #[test]
    fn add_dropped_dedups_by_path_within_a_batch_and_against_the_queue() {
        let mut ex =
            Executor::with_spawner(Box::new(|_job, _tx, _flag, _run| thread::spawn(|| {})));
        let a = PathBuf::from("/books/a.epub");

        let report = ex.add_dropped(&[a.clone(), a.clone()], DEFAULT_VOICE_ID);
        assert_eq!(report.enqueued, 1);
        assert_eq!(report.duplicates, vec![a.clone()], "in-batch duplicate");

        let report = ex.add_dropped(std::slice::from_ref(&a), DEFAULT_VOICE_ID);
        assert_eq!(report.enqueued, 0);
        assert_eq!(report.duplicates, vec![a], "duplicate against the queue");
        assert_eq!(ex.queue().jobs().count(), 1);
    }

    #[test]
    fn classify_drop_matches_extensions_case_insensitively_and_rejects_extensionless() {
        assert!(matches!(
            classify_drop(Path::new("/x/Book.EPUB")),
            DropPlan::Convert(_)
        ));
        assert!(matches!(
            classify_drop(Path::new("/x/notes.MD")),
            DropPlan::Convert(_)
        ));
        assert!(matches!(
            classify_drop(Path::new("/x/book.TaleTrek")),
            DropPlan::ReVoice(_)
        ));
        let plan = classify_drop(Path::new("/x/cover.png"));
        let DropPlan::Reject { reason, .. } = &plan else {
            panic!("png must be rejected");
        };
        assert!(reason.to_lowercase().contains("unsupported"));

        let plan = classify_drop(Path::new("/x/noextension"));
        let DropPlan::Reject { reason, .. } = &plan else {
            panic!("extensionless must be rejected");
        };
        assert!(reason.to_lowercase().contains("extension"));
    }

    // ---- execute_and_report ----

    #[test]
    fn execute_and_report_sends_finished_then_exited_on_success() {
        let (tx, rx) = crossbeam_channel::unbounded();
        execute_and_report(JobId::for_test(1), &tx, || {
            Ok(PathBuf::from("out.taletrek"))
        });
        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Event(QueueEvent::Finished {
                id: JobId::for_test(1),
                out: PathBuf::from("out.taletrek")
            })
        );
        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Exited(JobId::for_test(1))
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn execute_and_report_sends_failed_with_chained_context_then_exited() {
        let (tx, rx) = unbounded();
        execute_and_report(JobId::for_test(2), &tx, || {
            Err(anyhow::anyhow!("disk full").context("writing output bundle out.taletrek"))
        });
        let WorkerMsg::Event(QueueEvent::Failed { id, message }) = rx.try_recv().unwrap() else {
            panic!("expected Failed");
        };
        assert_eq!(id, JobId::for_test(2));
        assert!(
            message.contains("writing output bundle") && message.contains("disk full"),
            "chained context kept: {message}"
        );
        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Exited(JobId::for_test(2))
        );
    }

    #[test]
    fn execute_and_report_converts_a_panic_into_failed_not_a_deadlock() {
        let (tx, rx) = unbounded();
        execute_and_report(JobId::for_test(3), &tx, || panic!("worker exploded"));
        let WorkerMsg::Event(QueueEvent::Failed { id, message }) = rx.try_recv().unwrap() else {
            panic!("expected Failed");
        };
        assert_eq!(id, JobId::for_test(3));
        assert!(
            message.contains("internal error (panic)"),
            "panic surfaced as a message: {message}"
        );
        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Exited(JobId::for_test(3))
        );
    }

    // ---- run_convert_job_with ----

    #[test]
    fn convert_job_core_happy_path_reports_started_progress_and_writes_beside_input() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(
            dir.path(),
            "fable.txt",
            "Chapter One\n\nThe North Wind and the Sun were disputing.\n\nChapter Two\n\nThey parted as friends.",
        );
        let (tx, rx) = unbounded();

        let out = run_convert_job_with(
            JobId::for_test(1),
            &input,
            DEFAULT_VOICE_ID,
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &plain_run(1),
        )
        .expect("convert job core should succeed");

        assert_eq!(out, dir.path().join("fable.synth.taletrek"));
        assert!(out.is_file(), "bundle written beside the input");

        let bundle = read_book_bundle(&std::fs::read(&out).unwrap()).unwrap();
        assert!(bundle.manifest.audio.present);
        assert_eq!(bundle.manifest.audio.codec, AudioCodec::Wav);
        assert_eq!(bundle.manifest.book.voice_id, DEFAULT_VOICE_ID);
        assert_eq!(bundle.manifest.book.source_format, "txt");
        assert_eq!(
            bundle.manifest.generator.app,
            crate::bundle_io::GENERATOR_APP
        );

        // Event stream: Started{total:2} first, then Progress steps, and no
        // Finished/Exited (those belong to execute_and_report).
        let first = rx.try_recv().unwrap();
        assert_eq!(
            first,
            WorkerMsg::Event(QueueEvent::Started {
                id: JobId::for_test(1),
                total: 2
            }),
            "Started carries the paragraph count as the progress baseline"
        );
        let mut progress = 0;
        while let Ok(msg) = rx.try_recv() {
            assert!(
                matches!(msg, WorkerMsg::Event(QueueEvent::Progress { .. })),
                "only progress follows Started, got {msg:?}"
            );
            progress += 1;
        }
        assert!(progress >= 1, "at least one Progress event");
    }

    #[test]
    fn convert_job_core_fails_before_started_on_unsupported_extension() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "book.mobi", "bytes");
        let (tx, rx) = unbounded();

        let err = run_convert_job_with(
            JobId::for_test(1),
            &input,
            DEFAULT_VOICE_ID,
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &plain_run(1),
        )
        .expect_err("unsupported extension must fail the job");

        assert!(
            err.to_string().contains(".epub"),
            "actionable message: {err}"
        );
        // Failed before the reportable stages: no events were sent.
        assert!(rx.try_recv().is_err(), "no Started for a dead input");
    }

    #[test]
    fn convert_job_core_refuses_full_input_and_names_resynth() {
        let dir = tempfile::tempdir().unwrap();
        let source = write_input(dir.path(), "fable.txt", "One paragraph.");
        crate::run_parse(ParseArgs {
            input: source,
            voice: DEFAULT_VOICE_ID.to_string(),
            output: None,
        })
        .unwrap();
        let text_only = dir.path().join("fable.taletrek");
        let (tx, _rx) = unbounded();

        // First run: text-only input converts fine and writes a full bundle.
        let full = run_convert_job_with(
            JobId::for_test(1),
            &text_only,
            DEFAULT_VOICE_ID,
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &plain_run(1),
        )
        .expect("text-only input converts");
        assert!(full.is_file());

        // Second run on the full output: refused — that's re-voice's job.
        let err = run_convert_job_with(
            JobId::for_test(2),
            &full,
            DEFAULT_VOICE_ID,
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &plain_run(1),
        )
        .expect_err("synthesizing a full bundle must be refused");

        assert!(
            err.to_string().contains("already contains audio")
                && err.to_string().contains("resynth"),
            "guard message points at resynth: {err}"
        );
    }

    // ---- run_revoice_job_with (T8) ----

    #[test]
    fn revoice_job_core_revoices_a_full_bundle_and_leaves_the_input_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(
            dir.path(),
            "fable.txt",
            "Chapter One\n\nThe North Wind and the Sun were disputing.\n\nChapter Two\n\nThey parted as friends.",
        );
        let (tx, _rx) = unbounded();
        let full = run_convert_job_with(
            JobId::for_test(1),
            &input,
            DEFAULT_VOICE_ID,
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &plain_run(1),
        )
        .expect("convert first");
        let before = std::fs::read(&full).unwrap();

        let (tx, rx) = unbounded();
        let new_voice = "en_GB-alan-medium";
        let out = run_revoice_job_with(
            JobId::for_test(2),
            &full,
            new_voice,
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &plain_run(1),
        )
        .expect("re-voice should succeed");

        // Output beside the input as <stem>.<voice>.taletrek — the input
        // file itself is never clobbered.
        assert_eq!(
            out,
            dir.path().join(format!("fable.synth.{new_voice}.taletrek"))
        );
        assert_eq!(std::fs::read(&full).unwrap(), before, "input untouched");

        let bundle = read_book_bundle(&std::fs::read(&out).unwrap()).unwrap();
        assert!(bundle.manifest.audio.present, "re-voiced output is full");
        assert_eq!(bundle.manifest.book.voice_id, new_voice);
        assert_eq!(bundle.manifest.audio.segment_count, 2);
        assert_eq!(
            bundle.manifest.generator.app,
            crate::bundle_io::GENERATOR_APP
        );

        // Event stream mirrors Convert: Started{total} first, then progress.
        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Event(QueueEvent::Started {
                id: JobId::for_test(2),
                total: 2
            })
        );
        while let Ok(msg) = rx.try_recv() {
            assert!(
                matches!(msg, WorkerMsg::Event(QueueEvent::Progress { .. })),
                "only progress follows Started, got {msg:?}"
            );
        }
    }

    #[test]
    fn revoice_job_core_accepts_a_text_only_bundle() {
        // Re-voice is also the synth path for a text-only bundle (the CLI's
        // resynth accepts both — the GUI action must too).
        let dir = tempfile::tempdir().unwrap();
        let source = write_input(dir.path(), "one.txt", "Just one paragraph.");
        crate::run_parse(ParseArgs {
            input: source,
            voice: DEFAULT_VOICE_ID.to_string(),
            output: None,
        })
        .unwrap();
        let text_only = dir.path().join("one.taletrek");
        let (tx, _rx) = unbounded();

        let out = run_revoice_job_with(
            JobId::for_test(1),
            &text_only,
            "en_US-ryan-medium",
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &plain_run(1),
        )
        .expect("text-only re-voice should succeed");

        assert_eq!(out, dir.path().join("one.en_US-ryan-medium.taletrek"));
        let bundle = read_book_bundle(&std::fs::read(&out).unwrap()).unwrap();
        assert!(bundle.manifest.audio.present);
        assert_eq!(bundle.manifest.book.voice_id, "en_US-ryan-medium");
    }

    #[test]
    fn revoice_job_core_fails_before_started_on_a_non_bundle_input() {
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "broken.taletrek", "not a zip");
        let (tx, rx) = unbounded();

        let err = run_revoice_job_with(
            JobId::for_test(1),
            &input,
            "en_US-ryan-medium",
            &tx,
            &|| Ok(PathBuf::from("/dev/null")),
            |_| StubRunner,
            &WavPassthrough,
            &flag_off(),
            &plain_run(1),
        )
        .expect_err("a non-bundle input must fail the job");

        assert!(
            err.to_string().to_lowercase().contains("bundle"),
            "actionable message: {err}"
        );
        // Failed during load — before Started, so no events were sent.
        assert!(rx.try_recv().is_err(), "no Started for a dead input");
    }

    #[test]
    fn run_job_by_kind_dispatches_revoice_jobs() {
        // Dispatch through the production seam with a garbage input: the
        // load fails fast — no voice download, no engine spawned.
        let dir = tempfile::tempdir().unwrap();
        let input = write_input(dir.path(), "broken.taletrek", "not a zip");
        let (tx, rx) = unbounded();

        let err = run_job_by_kind(
            JobId::for_test(1),
            &JobKind::ReVoice {
                input,
                voice: "en_US-ryan-medium".to_string(),
            },
            &tx,
            &flag_off(),
            &plain_run(1),
        )
        .expect_err("garbage input must fail before any download");

        assert!(
            err.to_string().to_lowercase().contains("bundle"),
            "actionable message: {err}"
        );
        assert!(rx.try_recv().is_err());
    }
}
