//! Synth job runner — the async/sync bridge between the axum handlers and the
//! blocking worker pool.
//!
//! [`run_synth_job`] is the trigger entry point: it validates the book, creates
//! a `queued` job row, spawns the background synth, and returns the job id
//! immediately (→ HTTP `202`). The background task resolves the voice, flips the
//! row to `running`, runs the worker pool inside `spawn_blocking`, writes the
//! full bundle back through the store, and finally transitions the row to
//! `succeeded`/`failed`.
//!
//! # The async/sync bridge (two blocking seams)
//!
//! GOTCHA: the worker's rayon pool ([`taletrek_worker::synth_all_paragraphs`])
//! is synchronous — it blocks the calling thread for the whole run. It MUST run
//! inside [`tokio::task::spawn_blocking`], never awaited on the async runtime
//! directly. Voice resolution (`resolve_voice`) is also blocking (HTTP via
//! `ureq` + file I/O). Both run inside a single `spawn_blocking` closure so the
//! async runtime is never stalled — see [`run_job_to_completion`].
//!
//! The [`ProgressSink`] impl ([`JobProgress`]) is invoked from rayon worker
//! threads and writes to the DB synchronously — that's safe because the `Db` is
//! `Send + Sync` and each `update_job_status` is a quick `UPDATE` under the
//! SQLite mutex. v1 updates once per paragraph; SSE/throttling is a follow-on.
//!
//! # Stub-friendly backend
//!
//! [`SynthBackend`] type-erases the piper runner factory + encoder so tests
//! inject a stub runner + `WavPassthrough` (no piper/ffmpeg) while production
//! wires `SubprocessPiperRunner` + `OpusEncoder`. The erasure is necessary
//! because [`taletrek_worker::synth_and_stamp`] is generic over
//! `R: PiperRunner + Send` / `E: Encoder + Sync`; the handler holds the backend
//! in `AppState`, which can't be generic. Tests stay hermetic by pre-seeding
//! the voice cache (dummy `.onnx`/`.json`) so `resolve_voice` short-circuits
//! with no network — the stub runner ignores the model bytes.

use std::collections::HashSet;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use thiserror::Error;
use tracing::{error, warn};

use taletrek_synth::synth::SynthError;
use taletrek_synth::{
    read_book_bundle, write_book_bundle, AudioCodec, BookBundle, BundleError, Encoder, OpusEncoder,
    PiperRunner, SubprocessPiperRunner,
};
use taletrek_worker::voices::{
    find_curated, resolve_voice, ResolveError, ResolveOpts, UreqVoiceSource, DEFAULT_VOICE_ID,
};
use taletrek_worker::{refuse_full_input, resynth_and_stamp, synth_and_stamp, ProgressSink};

use crate::db::Db;
use crate::db::{now_ms, DbError, JobKind, JobRow, JobStatus};
use crate::store::{self, StoreError};

/// `generator.app` stamped into every server-synth'd bundle. Matches the
/// reserved value enumerated in `docs/bundle-format.md`'s producer list.
pub(crate) const GENERATOR_APP: &str = "taletrek-server";

/// Process-wide monotonic counter seeding unique job ids. Combined with the
/// wall-clock ms timestamp, ids are unique across restarts (the clock advances)
/// and within a single run (the counter never repeats). Avoids pulling a `uuid`
/// workspace dep for this one call site.
static JOB_SEQ: AtomicU64 = AtomicU64::new(0);

/// Build a fresh job id: `j<ms-since-epoch>-<seq>`.
fn new_job_id() -> String {
    let n = JOB_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("j{}-{}", now_ms(), n)
}

// ===== type-erased backend (runner factory + encoder) =====

/// Type-erased [`PiperRunner`]: owns one boxed runner and delegates `predict`.
///
/// Needed because [`synth_and_stamp`] is generic over `R: PiperRunner + Send`
/// but the server holds the runner factory in `AppState` (which can't be
/// generic). Each paragraph task calls the factory to produce a fresh
/// `AnyRunner`.
pub struct AnyRunner(Box<dyn PiperRunner + Send>);

impl PiperRunner for AnyRunner {
    fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
        self.0.predict(voice_model, text)
    }
}

/// Type-erased [`Encoder`], shared by `Arc` (`encode(&self)` is stateless, so a
/// single encoder is shared across every paragraph task — matches the worker's
/// "one shared encoder" decision).
#[derive(Clone)]
pub struct AnyEncoder(Arc<dyn Encoder + Send + Sync>);

impl AnyEncoder {
    /// Wrap a concrete encoder behind the type-erased seam.
    pub fn new<E>(encoder: E) -> Self
    where
        E: Encoder + Send + Sync + 'static,
    {
        Self(Arc::new(encoder))
    }
}

impl Encoder for AnyEncoder {
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError> {
        self.0.encode(wav)
    }
    fn codec(&self) -> AudioCodec {
        self.0.codec()
    }
}

/// Runner factory closure type: `Fn() -> AnyRunner`, shareable across threads.
/// The worker calls it once per paragraph to produce a fresh task-owned runner.
pub type MakeRunner = Arc<dyn Fn() -> AnyRunner + Send + Sync>;

/// The configured synth backend — runner factory + encoder.
///
/// Production wires subprocess piper + ffmpeg Opus
/// ([`SynthBackend::subprocess`]); tests wire in-process stubs via
/// [`test_support::stub_backend`] (no piper/ffmpeg). `Clone` is cheap (two
/// `Arc` clones).
#[derive(Clone)]
pub struct SynthBackend {
    /// Per-paragraph runner factory.
    make_runner: MakeRunner,
    /// Shared encoder (encode is stateless).
    encoder: AnyEncoder,
}

impl SynthBackend {
    /// Production backend: a subprocess `piper` runner per paragraph + an ffmpeg
    /// Opus encoder. `piper`/`ffmpeg` are the configured binary names or
    /// absolute paths (resolved from `PATH` when bare).
    pub fn subprocess(piper: String, ffmpeg: String) -> Self {
        Self {
            make_runner: Arc::new(move || AnyRunner(Box::new(SubprocessPiperRunner::new(&piper)))),
            encoder: AnyEncoder::new(OpusEncoder::new().with_binary(ffmpeg)),
        }
    }
}

/// Everything the synth runner needs from the server, bundled so the trigger
/// and the background task share one concrete, `Clone` handle. A thin
/// projection of [`crate::http::AppState`]'s pieces (all `Arc`/`PathBuf` —
/// cheap to clone).
#[derive(Clone)]
pub struct SynthContext {
    /// SQLite index + job-state (trait seam).
    pub db: Arc<dyn Db>,
    /// Library root (`<data_dir>/library/<book-id>/…`).
    pub data_dir: PathBuf,
    /// Voice-model cache dir (HF downloads land here; cache hits skip network).
    pub voices_cache_dir: PathBuf,
    /// Default parallel worker count when the request omits `jobs`.
    pub default_jobs: usize,
    /// Configured runner factory + encoder.
    pub backend: SynthBackend,
    /// Book ids with a synth/resynth job currently running. Shared with the
    /// HTTP delete path so a book can't be deleted (or re-triggered) under a
    /// running job — see [`InFlightBooks`].
    pub in_flight: InFlightBooks,
}

/// Book ids with a synth/resynth job currently running (process-wide).
///
/// Coordinates triggers and deletes against in-flight jobs: a second
/// synth/resynth trigger for the same book → [`SynthTriggerError::JobInProgress`]
/// (HTTP `409`), and `DELETE` while a job runs → `409` (see
/// `http::books::delete_book_id`). The background run releases its claim on
/// every exit path — success, failure, or panic. Belt-and-suspenders for the
/// claim-vs-delete race: [`run_job_to_completion`] re-checks the bundle still
/// exists before writing its output back, so a delete that slipped past the
/// guard can never be resurrected by the job's completion write.
///
/// This is process state, not persisted truth — on restart it starts empty
/// while the boot sweep fails orphaned job rows, so nothing stays blocked.
#[derive(Clone, Default)]
pub struct InFlightBooks {
    inner: Arc<Mutex<HashSet<String>>>,
}

impl InFlightBooks {
    /// Claim `book_id` for a new job. Returns `false` (no claim) when a job is
    /// already running for it.
    pub fn try_claim(&self, book_id: &str) -> bool {
        self.inner
            .lock()
            .expect("in-flight mutex poisoned")
            .insert(book_id.to_string())
    }

    /// Is a job currently running for `book_id`?
    pub fn contains(&self, book_id: &str) -> bool {
        self.inner
            .lock()
            .expect("in-flight mutex poisoned")
            .contains(book_id)
    }

    /// Release a claim (idempotent — safe on every exit path).
    pub fn release(&self, book_id: &str) {
        self.inner
            .lock()
            .expect("in-flight mutex poisoned")
            .remove(book_id);
    }
}

/// Ceiling for a request-supplied `jobs` override. The value flows into a
/// per-job rayon pool (`num_threads` → one OS thread + piper subprocess
/// each), so without a cap an authenticated caller could request thousands
/// of threads.
const MAX_REQUESTED_JOBS: usize = 32;

/// Clamp an effective worker count to `[1, MAX_REQUESTED_JOBS]`.
fn clamp_jobs(jobs: usize) -> usize {
    jobs.clamp(1, MAX_REQUESTED_JOBS)
}

// ===== errors =====

/// Errors from the trigger path (before/during job-row creation). The synth
/// itself runs in the background; its failures surface as a `failed` job row,
/// not here. Maps to HTTP statuses in the handler ([`crate::http::jobs`]).
#[derive(Debug, Error)]
pub enum SynthTriggerError {
    /// The book id is not in the library (→ `404`).
    #[error("book {0} not found")]
    BookNotFound(String),
    /// The stored bundle already carries audio (→ `409`); the caller should use
    /// `resynth` to re-voice it. Carries a ready-to-render message embedding the
    /// existing voice + a `resynth` hint.
    #[error("{message}")]
    AlreadyFull {
        /// The book id (for logging / future branching).
        #[allow(dead_code)]
        book: String,
        /// One-line message embedding the existing voice + a resynth hint.
        message: String,
    },
    /// The requested voice failed cheap pre-flight validation (→ `400`):
    /// unknown curated id, or a `voicePath` whose file / `.json` sibling is
    /// missing. Network/download failures are NOT here — those surface later as
    /// a `failed` job row.
    #[error("voice rejected: {0}")]
    BadVoice(#[from] ResolveError),
    /// The resynth request omitted `voice` (→ `400`). Synth defaults the voice;
    /// resynth requires an explicit target voice since the whole point is a
    /// voice swap.
    #[error("voice is required for resynth (the new voice to re-voice under)")]
    MissingVoice,
    /// A synth/resynth job is already running for this book (→ `409`). One job
    /// per book: two concurrent runs would double the synth work and race the
    /// final store write; deleting under a run would let the completion write
    /// resurrect the book.
    #[error("a synth job is already running for book {0}; poll GET /api/jobs and retry once it finishes")]
    JobInProgress(String),
    /// A blocking call (store read, bundle parse, db write, join) failed during
    /// triggering (→ `500`).
    #[error(transparent)]
    Internal(#[from] SynthInternalError),
}

/// Internal blocking-op error during triggering (store read + bundle parse + db
/// write + join). Kept as a distinct type so [`SynthTriggerError`] can lift it
/// without losing the source chain.
#[derive(Debug, Error)]
pub enum SynthInternalError {
    /// Bundle store read / write / id validation.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Bundle ZIP+JSON parse/serialize.
    #[error(transparent)]
    Bundle(#[from] BundleError),
    /// SQLite query.
    #[error(transparent)]
    Db(#[from] DbError),
    /// A `spawn_blocking` task panicked or was cancelled.
    #[error("spawn_blocking join failed: {0}")]
    Join(String),
}

/// Internal error from the background synth run. Surfaced only by being written
/// into the job row's `error` column (status → `failed`); never returned over
/// HTTP (the trigger already returned `202`).
#[derive(Debug, Error)]
enum JobRunError {
    #[error(transparent)]
    Resolve(#[from] ResolveError),
    #[error(transparent)]
    Stamp(#[from] taletrek_worker::StampError),
    #[error(transparent)]
    Bundle(#[from] BundleError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Db(#[from] DbError),
    /// The book was deleted while the job ran (the delete raced past the
    /// in-flight guard). The output is discarded instead of written — writing
    /// it would resurrect the deleted book.
    #[error("book {0} was deleted while the job was running; output discarded")]
    BookDeletedMidJob(String),
}

// ===== progress sink =====

/// [`ProgressSink`] that reflects per-paragraph synth progress into the job
/// row's `done`/`total` columns.
///
/// Constructed once per background run; holds the `Db` handle + job id. Each
/// `synth_step` is a single synchronous `UPDATE` — the sink is called from a
/// rayon worker thread inside the run's `spawn_blocking`, so blocking is fine
/// (it is never on the async runtime). A failed update is logged + swallowed:
/// losing a progress tick is preferable to poisoning the synth run.
///
/// `download_step` is a no-op in v1: voice-model download progress is not
/// surfaced through the job row (the row tracks synth progress only). Live
/// streaming / throttling is a follow-on.
struct JobProgress {
    db: Arc<dyn Db>,
    job_id: String,
}

impl ProgressSink for JobProgress {
    fn synth_step(&self, done: usize, total: usize) {
        if let Err(e) = self.db.update_job_status(
            &self.job_id,
            JobStatus::Running,
            Some(done as i64),
            Some(total as i64),
            None,
        ) {
            warn!(job = %self.job_id, error = %e, "job progress update failed");
        }
    }

    fn download_step(&self, _bytes_done: u64, _bytes_total: u64) {
        // v1 no-op — see type docs.
    }
}

// ===== trigger =====

/// Cheap pre-flight voice validation, run at trigger time (no network).
///
/// Mirrors the local checks [`taletrek_worker::resolve_voice`] makes before any
/// download: a `voicePath` override must exist + have its `.json` sibling; a
/// bare `voice` id (or the default) must be a known curated id. Download/cache
/// miss is deliberately NOT rejected here — it surfaces later as a `failed` job
/// if the network fetch fails.
fn preflight_voice(voice: Option<&str>, voice_path: Option<&Path>) -> Result<(), ResolveError> {
    if let Some(onnx) = voice_path {
        if !onnx.is_file() {
            return Err(ResolveError::VoicePathNotFound {
                path: onnx.to_path_buf(),
            });
        }
        let json = onnx.with_extension("json");
        if !json.is_file() {
            return Err(ResolveError::MissingJsonSibling {
                onnx: onnx.to_path_buf(),
                json,
            });
        }
        return Ok(());
    }
    let id = voice.unwrap_or(DEFAULT_VOICE_ID);
    if find_curated(id).is_none() {
        return Err(ResolveError::UnknownCuratedId(id.to_string()));
    }
    Ok(())
}

/// The prepared bundle + paragraph count, produced by the trigger's validation
/// `spawn_blocking` and handed to the background task so it need not re-read.
struct PreparedJob {
    bundle: BookBundle,
    total: usize,
}

/// Which worker stamp function the background job runs. Extracted so
/// [`run_job_to_completion`] serves both synth and resynth without copy-paste —
/// the two differ only at the stamp call site (everything else — voice resolve,
/// status transitions, store write, book-row upsert — is identical).
///
/// [`synth_and_stamp`] is text-only-input + guarded by `refuse_full_input` at
/// trigger; [`resynth_and_stamp`] rewrites `manifest.book.voice_id` to the new
/// voice first, then re-synthesizes, and accepts both text-only and full input
/// (stale audio under the old voice is discarded, not merged — see
/// [`taletrek_worker::resynth_and_stamp`]).
#[derive(Clone, Copy)]
enum StampStrategy {
    /// First-time synth of a text-only bundle.
    Synth,
    /// Re-voice under a new voice id (rewrites the manifest first).
    Resynth,
}

/// Load + parse + (optionally) refuse-full + count paragraphs. Shared by the
/// synth and resynth triggers so the store/parse/total logic lives once. The
/// `refuse_if_full` flag is `true` for synth (already-full → `409`) and `false`
/// for resynth (re-voicing a full bundle is the whole point).
fn load_and_prepare(
    data_dir: &Path,
    book_id: &str,
    refuse_if_full: bool,
) -> Result<PreparedJob, SynthTriggerError> {
    let bytes = store::get_bundle(data_dir, book_id).map_err(|e| match e {
        StoreError::NotFound(id) => SynthTriggerError::BookNotFound(id),
        other => SynthTriggerError::Internal(other.into()),
    })?;
    let bundle = read_book_bundle(&bytes).map_err(|e| SynthTriggerError::Internal(e.into()))?;
    if refuse_if_full {
        if let Err(full) = refuse_full_input(&bundle, book_id) {
            let voice = full.voice;
            let message = format!(
                "book {book_id} already contains audio (voice `{voice}`); \
                 use resynth to re-voice it"
            );
            return Err(SynthTriggerError::AlreadyFull {
                book: book_id.to_string(),
                message,
            });
        }
    }
    let total = bundle
        .chapters
        .iter()
        .map(|ch| ch.paragraphs.len())
        .sum::<usize>();
    Ok(PreparedJob { bundle, total })
}

/// Trigger a synth job for `book_id`.
///
/// Validates cheaply (book present, text-only, voice id/path plausible), creates
/// a `queued` job row with `total` = paragraph count, spawns the background
/// synth, and returns the job id immediately (→ HTTP `202`). The background task
/// ([`run_job_to_completion`]) does the expensive work (voice download, rayon
/// pool, store write) and flips the row to `succeeded`/`failed`.
///
/// `voice` defaults to [`DEFAULT_VOICE_ID`] when `None`. `jobs` defaults to
/// [`SynthContext::default_jobs`] when `None`.
pub async fn run_synth_job(
    ctx: SynthContext,
    book_id: String,
    voice: Option<String>,
    voice_path: Option<PathBuf>,
    jobs: Option<usize>,
) -> Result<String, SynthTriggerError> {
    // 1. Cheap voice pre-flight (no network) — bails with BadVoice before any
    //    store/db work.
    preflight_voice(voice.as_deref(), voice_path.as_deref())?;

    // 2. Load + parse + refuse-full + count paragraphs. All blocking → one
    //    spawn_blocking. Bails with BookNotFound / AlreadyFull / Internal
    //    BEFORE creating any job row (no orphan rows on trigger failure).
    let prep = {
        let data_dir = ctx.data_dir.clone();
        let book_id_check = book_id.clone();
        tokio::task::spawn_blocking(move || load_and_prepare(&data_dir, &book_id_check, true))
            .await
            .map_err(|e| SynthTriggerError::Internal(SynthInternalError::Join(e.to_string())))??
    };

    // 3. Claim the book — one job per book (a second concurrent run would
    //    double the work and race the final store write).
    if !ctx.in_flight.try_claim(&book_id) {
        return Err(SynthTriggerError::JobInProgress(book_id));
    }

    // 4. Resolve the effective voice id + create the `queued` job row.
    let voice_id = voice.unwrap_or_else(|| DEFAULT_VOICE_ID.to_string());
    let job_id = match create_job_row(
        ctx.db.clone(),
        &book_id,
        JobKind::Synth,
        &voice_id,
        prep.total,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            ctx.in_flight.release(&book_id);
            return Err(e);
        }
    };

    // 5. Spawn the detached background synth. A clone of the context carries
    //    every handle it needs; the handler has already returned by the time
    //    this runs.
    let jobs_eff = clamp_jobs(jobs.unwrap_or(ctx.default_jobs));
    tokio::spawn(run_job_to_completion(
        ctx,
        job_id.clone(),
        book_id,
        voice_id,
        voice_path,
        jobs_eff,
        prep.bundle,
        StampStrategy::Synth,
    ));

    Ok(job_id)
}

/// Trigger a resynth job for `book_id` — re-voice the book under `voice`.
///
/// Unlike [`run_synth_job`]: `voice` is **required** (the whole point is a
/// voice swap → `400` when omitted); the input may be text-only OR full (no
/// `refuse_full_input` guard); the job row is `kind=resynth`; and the
/// background run calls [`resynth_and_stamp`], which rewrites
/// `manifest.book.voice_id` to the new voice before re-synthesizing, so the
/// whole book is re-keyed under the new voice (stale old-voice audio is
/// discarded — not merged — matching the desktop `resynth` behavior).
pub async fn run_resynth_job(
    ctx: SynthContext,
    book_id: String,
    voice: Option<String>,
    voice_path: Option<PathBuf>,
    jobs: Option<usize>,
) -> Result<String, SynthTriggerError> {
    // 1. voice required + cheap pre-flight (no network).
    let voice_id = voice.ok_or(SynthTriggerError::MissingVoice)?;
    preflight_voice(Some(&voice_id), voice_path.as_deref())?;

    // 2. Load + parse + count paragraphs. NO refuse-full guard — resynth
    //    accepts both text-only and full input.
    let prep = {
        let data_dir = ctx.data_dir.clone();
        let book_id_check = book_id.clone();
        tokio::task::spawn_blocking(move || load_and_prepare(&data_dir, &book_id_check, false))
            .await
            .map_err(|e| SynthTriggerError::Internal(SynthInternalError::Join(e.to_string())))??
    };

    // 3. Claim the book (same one-job-per-book rule as synth).
    if !ctx.in_flight.try_claim(&book_id) {
        return Err(SynthTriggerError::JobInProgress(book_id));
    }

    // 4. Create the `queued` resynth job row.
    let job_id = match create_job_row(
        ctx.db.clone(),
        &book_id,
        JobKind::Resynth,
        &voice_id,
        prep.total,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            ctx.in_flight.release(&book_id);
            return Err(e);
        }
    };

    // 5. Spawn the detached background resynth.
    let jobs_eff = clamp_jobs(jobs.unwrap_or(ctx.default_jobs));
    tokio::spawn(run_job_to_completion(
        ctx,
        job_id.clone(),
        book_id,
        voice_id,
        voice_path,
        jobs_eff,
        prep.bundle,
        StampStrategy::Resynth,
    ));

    Ok(job_id)
}

/// Insert a `queued` job row (shared by synth + resynth triggers). Wraps the
/// blocking `Db::create_job` in `spawn_blocking`. Returns the job id on
/// success.
async fn create_job_row(
    db: Arc<dyn Db>,
    book_id: &str,
    kind: JobKind,
    voice_id: &str,
    total: usize,
) -> Result<String, SynthTriggerError> {
    let job_id = new_job_id();
    let now = now_ms();
    let row = JobRow {
        id: job_id.clone(),
        book_id: book_id.to_string(),
        kind,
        voice: voice_id.to_string(),
        status: JobStatus::Queued,
        done: 0,
        total: total as i64,
        error: None,
        created_at: now,
        updated_at: now,
    };
    let job_id_ret = job_id.clone();
    tokio::task::spawn_blocking(move || -> Result<(), SynthTriggerError> {
        db.create_job(row)
            .map_err(|e| SynthTriggerError::Internal(e.into()))?;
        Ok(())
    })
    .await
    .map_err(|e| SynthTriggerError::Internal(SynthInternalError::Join(e.to_string())))??;
    Ok(job_id_ret)
}

/// The background job runner, spawned (detached) by [`run_synth_job`] /
/// [`run_resynth_job`].
///
/// Runs the whole blocking sequence (voice resolve → stamp → store write
/// → book-row upsert → status transitions) inside one `spawn_blocking` so the
/// async runtime is never stalled. Any error (including a panic) flips the job
/// row to `failed` with a message; success flips it to `succeeded`.
///
/// `strategy` selects [`synth_and_stamp`] vs [`resynth_and_stamp`] — the only
/// step that differs between the two job kinds. Everything else (voice resolve,
/// status transitions, store write, book-row upsert) is shared, which is why
/// this is one function rather than two near-identical copies.
///
/// # Why `db` is cloned twice
///
/// The blocking closure consumes `ctx` (it needs every field by value). For the
/// failure path — which runs *after* the closure returns — we keep a separate
/// `Arc<dyn Db>` clone + the job id so the error handler can still write the
/// `failed` row. The panic path (the closure never returns) uses the same clone.
#[allow(clippy::too_many_arguments)] // 8 args: every one is a distinct, named input the background run needs; bundling would obscure the spawn_blocking contract (mirrors stamp.rs's allow on synth_and_stamp).
async fn run_job_to_completion(
    ctx: SynthContext,
    job_id: String,
    book_id: String,
    voice_id: String,
    voice_path: Option<PathBuf>,
    jobs: usize,
    mut bundle: BookBundle,
    strategy: StampStrategy,
) {
    // Clone for the post-closure failure / panic handlers (ctx is moved below)
    // + the post-join claim release.
    let db_for_failure = ctx.db.clone();
    let job_id_for_failure = job_id.clone();
    let book_id_for_release = book_id.clone();

    let run: tokio::task::JoinHandle<Result<(), JobRunError>> =
        tokio::task::spawn_blocking(move || -> Result<(), JobRunError> {
            // 1. Resolve the voice model (network + cache). Cache hit short-
            //    circuits the download. Download progress is a no-op in v1.
            let opts = ResolveOpts::new(voice_path, ctx.voices_cache_dir.clone());
            let voice_model = resolve_voice(Some(&voice_id), &opts, &UreqVoiceSource, None)?;

            // 2. Flip the row to running (voice already recorded at create).
            ctx.db
                .update_job_status(&job_id, JobStatus::Running, None, None, None)?;

            // 3. Parallel synth + stamp. The JobProgress sink writes
            //    done/total to the row from each rayon worker thread. Wrap the
            //    runner-factory Arc in a closure so it satisfies the worker's
            //    `F: Fn() -> R + Sync` bound (an `Arc<dyn Fn>` is not itself a
            //    closure; the move-closure captures the Arc by value and calls
            //    it by ref → Fn, not FnOnce). The two stamp functions share an
            //    identical signature, so only this call branches on strategy.
            let progress = JobProgress {
                db: ctx.db.clone(),
                job_id: job_id.clone(),
            };
            let make_runner = ctx.backend.make_runner.clone();
            let encoder = &ctx.backend.encoder;
            match strategy {
                // Both stamp functions write the effective voice into
                // `manifest.book.voiceId` (worker-level format contract —
                // importers compute segment keys from the manifest voice), so
                // the server's stored bundle always plays on import.
                StampStrategy::Synth => synth_and_stamp(
                    &mut bundle,
                    &voice_id,
                    &voice_model,
                    move || make_runner(),
                    encoder,
                    jobs,
                    GENERATOR_APP,
                    Some(&progress),
                ),
                StampStrategy::Resynth => resynth_and_stamp(
                    &mut bundle,
                    &voice_id,
                    &voice_model,
                    move || make_runner(),
                    encoder,
                    jobs,
                    GENERATOR_APP,
                    Some(&progress),
                ),
            }?;

            // 4. Guard against a delete that raced past the in-flight claim:
            //    if the book vanished while the job ran, discard the output —
            //    writing it back would resurrect the deleted book. Also clear
            //    the stale index row (the HTTP delete path normally owns both).
            if !store::bundle_exists(&ctx.data_dir, &book_id)? {
                let _ = ctx.db.delete_book(&book_id);
                return Err(JobRunError::BookDeletedMidJob(book_id.clone()));
            }

            // 5. Serialize + store the full bundle (idempotent overwrite).
            let mut buf = Cursor::new(Vec::new());
            write_book_bundle(&bundle, &mut buf)?;
            store::put_bundle(&ctx.data_dir, &book_id, &buf.into_inner())?;

            // 6. Reflect audio_present=true in the books index row (created_at
            //    preserved across the upsert).
            upsert_book_after_synth(&ctx.db, &book_id, &bundle)?;

            // 7. Terminal success.
            ctx.db
                .update_job_status(&job_id, JobStatus::Succeeded, None, None, None)?;
            Ok(())
        });

    let result = run.await;
    // Release the in-flight claim on every exit path — success, failure, or a
    // panicked task (the JoinError arm below).
    ctx.in_flight.release(&book_id_for_release);
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => mark_failed(&db_for_failure, &job_id_for_failure, &e.to_string()).await,
        Err(join_err) => {
            error!(job = %job_id_for_failure, error = %join_err, "synth background task panicked");
            mark_failed(
                &db_for_failure,
                &job_id_for_failure,
                &format!("synth background task panicked: {join_err}"),
            )
            .await;
        }
    }
}

/// Best-effort `failed` transition: writes `status=failed` + the message. Errors
/// are only logged (the row is already in a terminal-or-broken state if this
/// fails; nothing more the server can do for v1).
async fn mark_failed(db: &Arc<dyn Db>, job_id: &str, message: &str) {
    let db = db.clone();
    let job_id = job_id.to_string();
    let message = message.to_string();
    if let Err(e) = tokio::task::spawn_blocking(move || {
        db.update_job_status(&job_id, JobStatus::Failed, None, None, Some(&message))
    })
    .await
    {
        error!(error = %e, "failed to mark synth job as failed");
    }
}

/// Refresh the `books` row for `book_id` after a successful synth so the index
/// shows `audio_present=true`. `created_at` is preserved from the existing row
/// (synth is not a re-import); `updated_at` bumps to now. The manifest's own
/// `book.*` fields are the source of truth for everything else.
fn upsert_book_after_synth(
    db: &Arc<dyn Db>,
    book_id: &str,
    bundle: &BookBundle,
) -> Result<(), DbError> {
    let existing = db.get_book(book_id)?;
    let created_at = existing.map(|e| e.created_at).unwrap_or_else(now_ms);
    let book = &bundle.manifest.book;
    db.upsert_book(crate::db::BookRow {
        id: book_id.to_string(),
        title: book.title.clone(),
        author: book.author.clone(),
        source_format: book.source_format.clone(),
        voice_id: book.voice_id.clone(),
        audio_present: true,
        chapter_count: bundle.chapters.len() as i64,
        created_at,
        updated_at: now_ms(),
        // `None` resets the explode marker: the bundle was just rewritten, so
        // the next `GET .../chapters` re-explodes (compare-on-request, no
        // coupling — see http::chapters).
        exploded_at: None,
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Test-only stubs for the synth backend: an in-process `PiperRunner` that
    //! returns a fixed canonical WAV (no `piper` subprocess) + the `WavPassthrough`
    //! encoder (no `ffmpeg`). Lets the HTTP + runner tests exercise the full
    //! synth loop without native deps.

    use super::*;
    use taletrek_synth::WavPassthrough;

    /// Canonical mono 16-bit 16 kHz WAV with `pcm` as its data payload — the
    /// shape Piper emits on stdout and `WavPassthrough` expects. Mirrors the
    /// worker's test stubs.
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

    /// In-process piper runner: returns a fixed canonical WAV regardless of
    /// input. `PiperRunner` is called per-paragraph, so no state is needed.
    /// NOT for production.
    pub(crate) struct StubRunner;

    impl PiperRunner for StubRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    /// A backend wired to the in-process stub runner + `WavPassthrough`. No
    /// piper / ffmpeg needed.
    pub(crate) fn stub_backend() -> SynthBackend {
        SynthBackend {
            make_runner: Arc::new(|| AnyRunner(Box::new(StubRunner))),
            encoder: AnyEncoder::new(WavPassthrough),
        }
    }

    /// A backend whose runner blocks in `predict` until [`Gate::open`] is
    /// called — lets HTTP tests hold a synth job deterministically in
    /// `running` while they exercise the in-flight guard (second trigger,
    /// delete) mid-job. After opening, every subsequent `predict` passes.
    pub(crate) fn gated_backend() -> (SynthBackend, Gate) {
        type SharedGate = Arc<(Mutex<bool>, std::sync::Condvar)>;
        struct GatedRunner(SharedGate);
        impl PiperRunner for GatedRunner {
            fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
                let (lock, cv) = &*self.0;
                let mut open = lock.lock().expect("gate mutex poisoned");
                while !*open {
                    open = cv.wait(open).expect("gate mutex poisoned");
                }
                Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
            }
        }
        let gate: SharedGate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let make_gate = gate.clone();
        (
            SynthBackend {
                make_runner: Arc::new(move || AnyRunner(Box::new(GatedRunner(make_gate.clone())))),
                encoder: AnyEncoder::new(WavPassthrough),
            },
            Gate(gate),
        )
    }

    /// The release handle for a [`gated_backend`] run.
    pub(crate) struct Gate(Arc<(Mutex<bool>, std::sync::Condvar)>);

    impl Gate {
        /// Let every blocked (and future) `predict` call through.
        pub(crate) fn open(&self) {
            let (lock, cv) = &*self.0;
            let mut open = lock.lock().expect("gate mutex poisoned");
            *open = true;
            cv.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_jobs_is_clamped_to_a_sane_range() {
        assert_eq!(clamp_jobs(0), 1);
        assert_eq!(clamp_jobs(1), 1);
        assert_eq!(clamp_jobs(8), 8);
        assert_eq!(clamp_jobs(10_000), MAX_REQUESTED_JOBS);
    }
}
