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
//! # Shutdown
//!
//! [`Executor::shutdown`] joins the running job thread: closing the window
//! while a job runs waits for that job to finish so the output bundle is
//! never half-written (per-paragraph cancellation is T9's work; a hard kill
//! is deliberately out of scope).

use std::any::Any;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use crossbeam_channel::{Receiver, Sender};

use taletrek_synth::synth::PiperRunner;
use taletrek_synth::{read_book_bundle, BookBundle, Encoder};
use taletrek_worker::{default_cache_dir, resolve_voice, ResolveOpts, UreqVoiceSource};

use super::queue::{Job, JobId, JobKind, Queue, QueueEvent};
use super::sink::{ChannelSink, WorkerMsg};
use crate::bundle_io::{
    default_resynth_output, default_synth_output, refuse_full_input, resynth_and_stamp,
    synth_and_stamp, write_book_bundle_file,
};
use crate::engine::{effective_jobs, DesktopEncoder, DesktopRunner, RunnerSpec};

/// How the executor starts a job thread. A seam so unit tests script job
/// outcomes (canned event sequences) instead of running the real engine.
///
/// The contract: the returned thread must send [`WorkerMsg::Exited`] for the
/// job as its **last** message, on every exit path — that is what clears
/// the executor's bookkeeping and admits the next job.
type JobThreadSpawner = Box<dyn FnMut(Job, Sender<WorkerMsg>) -> JoinHandle<()>>;

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
                        self.current_handle = None;
                        self.download = None;
                    }
                }
            }
        }
    }

    /// Start the next queued job if the executor is idle. Exactly one
    /// thread per job, sequential FIFO — parallelism lives *within* a job
    /// (the synth pool), per the execution model.
    pub fn pump(&mut self) {
        if self.current_job.is_some() {
            return;
        }
        let Some(job) = self.queue.next_job().cloned() else {
            return;
        };
        self.current_job = Some(job.id);
        self.download = None;
        self.current_handle = Some((self.spawn)(job, self.tx.clone()));
    }

    /// Graceful shutdown: join the running job thread (waits for the job to
    /// finish — see [module docs](self)). Call from `App::on_exit`.
    pub fn shutdown(&mut self) {
        if let Some(handle) = self.current_handle.take() {
            let _ = handle.join();
        }
        self.current_job = None;
        self.download = None;
    }
}

/// The production spawner: one OS thread per job, reporting the outcome via
/// [`execute_and_report`].
fn spawn_job_thread(job: Job, tx: Sender<WorkerMsg>) -> JoinHandle<()> {
    thread::spawn(move || {
        let id = job.id;
        execute_and_report(id, &tx, || run_job_by_kind(id, &job.kind, &tx));
    })
}

/// Run `job_body`, then report its outcome as the job's final events:
/// `Finished` (with the written bundle's path), `Failed` (chained error
/// message), or `Failed` on a panic (a panicking job must not deadlock the
/// queue). Always sends [`WorkerMsg::Exited`] last — the executor's
/// next-job admission depends on it.
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
                message: format!("{err:#}"),
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
fn run_job_by_kind(id: JobId, kind: &JobKind, tx: &Sender<WorkerMsg>) -> Result<PathBuf> {
    match kind {
        JobKind::Convert { input, voice } => run_convert_job(id, input, voice, tx),
        JobKind::ReVoice { input, voice } => run_revoice_job(id, input, voice, tx),
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

/// The Convert pipeline with the production seams: native engines (T5
/// defaults — no overrides in T7; settings arrive in T9) and the real voice
/// resolver (curated catalog → cache or blocking download, progress
/// forwarded through the sink).
fn run_convert_job(
    id: JobId,
    input: &Path,
    voice: &str,
    tx: &Sender<WorkerMsg>,
) -> Result<PathBuf> {
    run_convert_job_with(
        id,
        input,
        voice,
        tx,
        &resolve_curated(id, voice, tx),
        move |voice_model| DesktopRunner::new(spec_for_gui(), voice_model),
        &encoder_for_gui()?,
        native_jobs(),
    )
}

/// Select the native runner spec (the GUI's fixed T7 engine choice).
fn spec_for_gui() -> RunnerSpec {
    RunnerSpec::select(None).expect("GUI builds carry the native engine features")
}

/// Select the native encoder (the GUI's fixed T7 encoder choice).
fn encoder_for_gui() -> Result<DesktopEncoder> {
    DesktopEncoder::select(None)
}

/// The GUI's job count: the native engine's default (2 — per-model memory).
fn native_jobs() -> usize {
    effective_jobs(None, &spec_for_gui())
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
///    factory + encoder (progress → [`QueueEvent::Progress`]),
/// 5. write the full bundle beside the input (`<stem>.synth.taletrek` —
///    the CLI naming rule, [`default_synth_output`]).
///
/// Returns the written output path; the caller ([`execute_and_report`])
/// turns `Ok`/`Err` into `Finished`/`Failed` events.
#[allow(clippy::too_many_arguments)] // mirrors the CLI's `run_synth_with` seam set (identity + channel + three injectables); grouping would hide the test seams.
fn run_convert_job_with<R, E, F>(
    id: JobId,
    input: &Path,
    voice: &str,
    tx: &Sender<WorkerMsg>,
    resolve_voice_model: &dyn Fn() -> Result<PathBuf>,
    make_runner_of: F,
    encoder: &E,
    jobs: usize,
) -> Result<PathBuf>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn(&Path) -> R + Sync,
{
    let mut bundle = crate::load_synth_input(input, voice)?;
    refuse_full_input(&bundle, input)?;

    let total = paragraph_count(&bundle);
    let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total }));

    let sink = ChannelSink::new(tx.clone(), id);
    let voice_model = resolve_voice_model()?;

    let factory_model = voice_model.clone();
    synth_and_stamp(
        &mut bundle,
        voice,
        &voice_model,
        move || make_runner_of(&factory_model),
        encoder,
        jobs,
        Some(&sink),
    )?;

    let output = default_synth_output(input);
    write_book_bundle_file(&bundle, &output)
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
/// bundle beside the input as `<stem>.<voice>.taletrek`.
fn run_revoice_job(
    id: JobId,
    input: &Path,
    voice: &str,
    tx: &Sender<WorkerMsg>,
) -> Result<PathBuf> {
    run_revoice_job_with(
        id,
        input,
        voice,
        tx,
        &resolve_curated(id, voice, tx),
        move |voice_model| DesktopRunner::new(spec_for_gui(), voice_model),
        &encoder_for_gui()?,
        native_jobs(),
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
/// 5. write the bundle beside the input as `<stem>.<voice>.taletrek`
///    ([`default_resynth_output`]) — never clobbering the input.
#[allow(clippy::too_many_arguments)] // mirrors `run_convert_job_with`'s seam set (identity + channel + three injectables)
fn run_revoice_job_with<R, E, F>(
    id: JobId,
    input: &Path,
    voice: &str,
    tx: &Sender<WorkerMsg>,
    resolve_voice_model: &dyn Fn() -> Result<PathBuf>,
    make_runner_of: F,
    encoder: &E,
    jobs: usize,
) -> Result<PathBuf>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn(&Path) -> R + Sync,
{
    let input_bytes =
        fs::read(input).with_context(|| format!("reading input bundle {}", input.display()))?;
    let mut bundle = read_book_bundle(&input_bytes)?;

    let total = paragraph_count(&bundle);
    let _ = tx.send(WorkerMsg::Event(QueueEvent::Started { id, total }));

    let sink = ChannelSink::new(tx.clone(), id);
    let voice_model = resolve_voice_model()?;

    let factory_model = voice_model.clone();
    resynth_and_stamp(
        &mut bundle,
        voice,
        &voice_model,
        move || make_runner_of(&factory_model),
        encoder,
        jobs,
        Some(&sink),
    )?;

    let output = default_resynth_output(input, voice);
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

    // ---- Executor: add_files / add_bundles / pump / drain ----

    #[test]
    fn add_files_queues_convert_jobs_in_order_with_the_given_voice() {
        let mut ex = Executor::with_spawner(Box::new(|_job, _tx| thread::spawn(|| {})));
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
        let mut ex = Executor::with_spawner(Box::new(|_job, _tx| thread::spawn(|| {})));
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
        let mut ex = Executor::with_spawner(Box::new(|_job, _tx| thread::spawn(|| {})));
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
        let mut ex = Executor::with_spawner(Box::new(move |_job, _tx| {
            counter.fetch_add(1, Ordering::SeqCst);
            thread::spawn(|| {})
        }));
        ex.add_files(&[PathBuf::from("a.txt")], DEFAULT_VOICE_ID);

        ex.pump();
        ex.pump();
        ex.drain();
        ex.pump();
        assert_eq!(spawns.load(Ordering::SeqCst), 1, "one spawn per job");
        assert!(ex.current_job().is_some());
        assert!(ex.is_busy());
    }

    #[test]
    fn jobs_run_sequentially_and_events_reach_the_queue() {
        // Scripted threads: Started → Progress → Finished → Exited.
        let mut ex = Executor::with_spawner(Box::new(|job, tx| {
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

        ex.pump();
        // a finishes; b must still be Queued until then.
        wait_until(&mut ex, |ex| {
            matches!(ex.queue().get(ids[0]).unwrap().state, JobState::Done(_))
        });
        assert_eq!(
            ex.queue().get(ids[1]).unwrap().state,
            JobState::Queued,
            "second job waits while the first runs"
        );

        ex.pump();
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
        let mut ex = Executor::with_spawner(Box::new(move |_job, tx| {
            *slot.lock().unwrap() = Some(tx.clone());
            thread::spawn(|| {})
        }));
        let ids = ex.add_files(&[PathBuf::from("a.txt")], DEFAULT_VOICE_ID);
        ex.pump();
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
        ex.pump();
        tx.send(WorkerMsg::Exited(JobId::for_test(999))).unwrap();
        ex.drain();
        assert_eq!(
            ex.current_job(),
            Some(ids2[0]),
            "ghost Exited changes nothing"
        );
        ex.shutdown();
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
            1,
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
            1,
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
            1,
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
            1,
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
            1,
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
            1,
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
            1,
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
            1,
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
        )
        .expect_err("garbage input must fail before any download");

        assert!(
            err.to_string().to_lowercase().contains("bundle"),
            "actionable message: {err}"
        );
        assert!(rx.try_recv().is_err());
    }
}
