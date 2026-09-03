//! Pure job-queue state machine for the desktop GUI (T6).
//!
//! The UI-free heart of the GUI: every state transition is a pure function
//! of an event. The egui layer (T7+) only *renders* a [`Queue`] and forwards
//! user actions and worker callbacks as [`QueueEvent`]s through [`Queue::tick`]
//! — no queue logic may live in UI code, and no UI type may appear here.
//!
//! Execution model (per spec): jobs run **sequentially** (at most one job
//! [`JobState::Running`] at a time) while paragraphs synthesize in parallel
//! *within* a job — the executor drives a job on a background thread and
//! reports paragraph progress as events.
//!
//! All transitions are total and defensive: an event naming an unknown job
//! is a no-op, an event that doesn't apply to the job's current state is a
//! no-op, and cancelling a job in a terminal state ([`JobState::Done`],
//! [`JobState::Failed`], [`JobState::Cancelled`]) is a no-op. The queue
//! therefore never panics on out-of-order or stale events — e.g. progress
//! from a paragraph racing a user cancel.

use std::collections::VecDeque;
use std::path::PathBuf;

/// Opaque, monotonically increasing identifier for a queued job.
///
/// Issued by [`Queue::push`]; names the target job in every [`QueueEvent`]
/// and in [`Queue::cancel`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct JobId(u64);

impl JobId {
    /// Test-only constructor for sibling modules' tests (`sink`, `executor`).
    /// The field stays private — production ids are issued by [`Queue::push`].
    #[cfg(test)]
    pub(crate) fn for_test(n: u64) -> Self {
        Self(n)
    }
}

/// What a job does when the executor runs it.
///
/// Both kinds carry the input path and the voice id (e.g.
/// `en_US-hfc_female-medium`, or the resolved default
/// `DEFAULT_VOICE_ID`); the difference is input acceptance, mirroring the
/// CLI's `synth` vs `resynth` split:
///
/// - [`JobKind::Convert`] turns a source document or text-only bundle into
///   a full audio bundle (a full input is refused — the re-voice job exists
///   for that).
/// - [`JobKind::ReVoice`] re-voices a text-only *or* full bundle with a new
///   voice (the manifest's voice is rewritten before synth).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobKind {
    /// Source document or text-only bundle → full `.taletrek` (CLI `synth`).
    Convert {
        /// Input path: any parseable source format, or `.taletrek`.
        input: PathBuf,
        /// Voice id to synthesize with.
        voice: String,
    },
    /// Any bundle → re-voiced `.taletrek` (CLI `resynth`).
    ///
    /// Queued by the GUI's "Add existing bundle…" action (the voice
    /// picker's re-voice path, T8) and dispatched by the executor.
    ReVoice {
        /// Input path: a `.taletrek` bundle (text-only or full).
        input: PathBuf,
        /// The new voice id.
        voice: String,
    },
}

/// Lifecycle state of a single job. Terminal states are [`JobState::Done`],
/// [`JobState::Failed`], and [`JobState::Cancelled`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    /// Waiting for its turn (FIFO order).
    Queued,
    /// Executing; `done` of `total` paragraphs have synthesized.
    Running {
        /// Paragraphs completed so far.
        done: usize,
        /// Total paragraphs in the book.
        total: usize,
    },
    /// Finished; the written bundle's path.
    Done(PathBuf),
    /// Failed; the error message to show.
    Failed(String),
    /// Cancelled by the user (from `Queued` or `Running`).
    Cancelled,
}

/// A single entry in the [`Queue`]: identity + kind + current state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    /// The job's identifier.
    pub id: JobId,
    /// What to run.
    pub kind: JobKind,
    /// Where it is in the lifecycle.
    pub state: JobState,
}

/// The one event type the queue understands — worker callbacks and user
/// actions both arrive as these, applied via [`Queue::tick`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueEvent {
    /// The executor started the job; `total` paragraphs to synthesize.
    /// No-op unless the job is `Queued` and no other job is `Running`
    /// (sequential jobs — enforced here, not by trust in the executor).
    Started {
        /// The job that started.
        id: JobId,
        /// Total paragraph count for progress display.
        total: usize,
    },
    /// Another paragraph finished. No-op unless the job is `Running`;
    /// `done` is clamped to `total`.
    Progress {
        /// The running job.
        id: JobId,
        /// Paragraphs completed so far.
        done: usize,
    },
    /// The job finished and its bundle was written. No-op unless the job
    /// is `Running`.
    Finished {
        /// The job that finished.
        id: JobId,
        /// Path of the written `.taletrek` bundle.
        out: PathBuf,
    },
    /// The job failed. No-op unless the job is `Queued` or `Running` — a
    /// job can fail *before* it starts (unreadable input, no cache dir),
    /// when the executor hasn't reported [`QueueEvent::Started`] yet.
    Failed {
        /// The job that failed.
        id: JobId,
        /// Human-readable error message.
        message: String,
    },
    /// The user cancelled the job — no-op from terminal states. Sent by
    /// [`Queue::cancel`]; a still-executing thread's subsequent events for
    /// this job simply no-op.
    #[allow(dead_code)] // constructed by the cancel UX (T9); matched already
    Cancelled {
        /// The job to cancel.
        id: JobId,
    },
}

/// FIFO job queue — the single source of truth the GUI renders.
///
/// Transitions happen only in [`Queue::tick`]; reads ([`Queue::jobs`],
/// [`Queue::get`], [`Queue::next_job`]) are for the render loop.
#[derive(Debug, Default)]
pub struct Queue {
    /// Next identifier to issue (ids start at 1; 0 is never handed out).
    next_id: u64,
    /// Jobs in arrival order (front = oldest = next to run).
    jobs: VecDeque<Job>,
}

impl Queue {
    /// An empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a job in `Queued` state; returns its fresh [`JobId`].
    pub fn push(&mut self, kind: JobKind) -> JobId {
        self.next_id += 1;
        let id = JobId(self.next_id);
        self.jobs.push_back(Job {
            id,
            kind,
            state: JobState::Queued,
        });
        id
    }

    /// Apply one event — the only state transition.
    ///
    /// Total and defensive (see [module docs](self)): unknown-job events,
    /// state-mismatched events, a second [`QueueEvent::Started`] while a
    /// job is already running, and events for cancelled jobs are all
    /// silent no-ops.
    pub fn tick(&mut self, event: QueueEvent) {
        let id = match &event {
            QueueEvent::Started { id, .. }
            | QueueEvent::Progress { id, .. }
            | QueueEvent::Finished { id, .. }
            | QueueEvent::Failed { id, .. }
            | QueueEvent::Cancelled { id } => *id,
        };
        // One job Running at a time — decided before the mutable borrow.
        let another_running = self
            .jobs
            .iter()
            .any(|j| j.id != id && matches!(j.state, JobState::Running { .. }));
        let Some(job) = self.jobs.iter_mut().find(|j| j.id == id) else {
            return; // unknown job — defensive no-op
        };
        match event {
            QueueEvent::Started { total, .. } => {
                if matches!(job.state, JobState::Queued) && !another_running {
                    job.state = JobState::Running { done: 0, total };
                }
            }
            QueueEvent::Progress { done, .. } => {
                if let JobState::Running { done: d, total } = &mut job.state {
                    *d = done.min(*total);
                }
            }
            QueueEvent::Finished { out, .. } => {
                if matches!(job.state, JobState::Running { .. }) {
                    job.state = JobState::Done(out);
                }
            }
            QueueEvent::Failed { message, .. } => {
                if matches!(job.state, JobState::Queued | JobState::Running { .. }) {
                    job.state = JobState::Failed(message);
                }
            }
            QueueEvent::Cancelled { .. } => {
                if matches!(job.state, JobState::Queued | JobState::Running { .. }) {
                    job.state = JobState::Cancelled;
                }
            }
        }
    }

    /// The next job to run: the first `Queued` job in FIFO order, if any.
    ///
    /// A peek, not a transition — the job moves to `Running` only when the
    /// executor reports [`QueueEvent::Started`].
    pub fn next_job(&self) -> Option<&Job> {
        self.jobs
            .iter()
            .find(|j| matches!(j.state, JobState::Queued))
    }

    /// User cancel: `Queued`/`Running` → `Cancelled`; terminal states
    /// (notably `Done`) are no-ops. Sugar for
    /// `tick(QueueEvent::Cancelled { id })`.
    #[allow(dead_code)] // the cancel button arrives in T9 (failure/cancel UX)
    pub fn cancel(&mut self, id: JobId) {
        self.tick(QueueEvent::Cancelled { id });
    }

    /// All jobs in arrival order (front = oldest) — the render list.
    pub fn jobs(&self) -> impl Iterator<Item = &Job> {
        self.jobs.iter()
    }

    /// Look up one job by id — detail views.
    #[allow(dead_code)] // detail views (T9); executor tests use it today
    pub fn get(&self, id: JobId) -> Option<&Job> {
        self.jobs.iter().find(|j| j.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert(input: &str) -> JobKind {
        JobKind::Convert {
            input: PathBuf::from(input),
            voice: "en_US-hfc_female-medium".to_string(),
        }
    }

    fn revoice(input: &str) -> JobKind {
        JobKind::ReVoice {
            input: PathBuf::from(input),
            voice: "en_GB-northern_english_male-medium".to_string(),
        }
    }

    #[test]
    fn happy_path_queued_to_started_progress_finished() {
        let mut q = Queue::new();
        let id = q.push(convert("fable.txt"));

        assert_eq!(q.get(id).unwrap().state, JobState::Queued);
        assert_eq!(q.next_job().unwrap().id, id, "sole job is next");

        q.tick(QueueEvent::Started { id, total: 3 });
        assert_eq!(
            q.get(id).unwrap().state,
            JobState::Running { done: 0, total: 3 }
        );

        q.tick(QueueEvent::Progress { id, done: 1 });
        q.tick(QueueEvent::Progress { id, done: 2 });
        assert_eq!(
            q.get(id).unwrap().state,
            JobState::Running { done: 2, total: 3 }
        );

        let out = PathBuf::from("fable.synth.taletrek");
        q.tick(QueueEvent::Finished {
            id,
            out: out.clone(),
        });
        assert_eq!(q.get(id).unwrap().state, JobState::Done(out));
        assert!(q.next_job().is_none(), "nothing left to run");
    }

    #[test]
    fn revoice_happy_path_transitions_like_convert_and_keeps_its_kind() {
        // T8: the re-voice action queues JobKind::ReVoice — the lifecycle
        // transitions are kind-agnostic, but the kind (and its voice
        // override) must survive to the terminal state for rendering.
        let mut q = Queue::new();
        let id = q.push(revoice("fable.synth.taletrek"));

        q.tick(QueueEvent::Started { id, total: 4 });
        q.tick(QueueEvent::Progress { id, done: 3 });
        let out = PathBuf::from("fable.synth.en_GB-alan-medium.taletrek");
        q.tick(QueueEvent::Finished {
            id,
            out: out.clone(),
        });

        let job = q.get(id).unwrap();
        assert_eq!(job.state, JobState::Done(out));
        assert_eq!(
            job.kind,
            JobKind::ReVoice {
                input: PathBuf::from("fable.synth.taletrek"),
                voice: "en_GB-northern_english_male-medium".to_string()
            }
        );
    }

    #[test]
    fn mid_progress_failure_is_terminal_and_later_events_no_op() {
        let mut q = Queue::new();
        let id = q.push(convert("book.epub"));
        q.tick(QueueEvent::Started { id, total: 5 });
        q.tick(QueueEvent::Progress { id, done: 2 });

        q.tick(QueueEvent::Failed {
            id,
            message: "voice download failed".to_string(),
        });
        assert_eq!(
            q.get(id).unwrap().state,
            JobState::Failed("voice download failed".to_string())
        );

        // Stale events after the terminal state are no-ops.
        q.tick(QueueEvent::Progress { id, done: 3 });
        q.tick(QueueEvent::Finished {
            id,
            out: PathBuf::from("book.synth.taletrek"),
        });
        assert_eq!(
            q.get(id).unwrap().state,
            JobState::Failed("voice download failed".to_string())
        );
    }

    #[test]
    fn failure_before_start_marks_a_queued_job_failed() {
        // The executor reports Started only after the input loads (it needs
        // the paragraph count) — a load failure must therefore land on a
        // Queued job, or the job would be retried forever.
        let mut q = Queue::new();
        let id = q.push(convert("broken.txt"));
        q.tick(QueueEvent::Failed {
            id,
            message: "reading source document broken.txt".to_string(),
        });
        assert_eq!(
            q.get(id).unwrap().state,
            JobState::Failed("reading source document broken.txt".to_string())
        );
        assert!(q.next_job().is_none(), "a pre-start failure never runs");
    }

    #[test]
    fn cancel_during_run_marks_cancelled_and_racing_events_no_op() {
        let mut q = Queue::new();
        let id = q.push(convert("book.docx"));
        q.tick(QueueEvent::Started { id, total: 4 });
        q.tick(QueueEvent::Progress { id, done: 1 });

        q.cancel(id);
        assert_eq!(q.get(id).unwrap().state, JobState::Cancelled);

        // The still-executing thread reports progress/finish — no-ops.
        q.tick(QueueEvent::Progress { id, done: 2 });
        q.tick(QueueEvent::Finished {
            id,
            out: PathBuf::from("book.synth.taletrek"),
        });
        assert_eq!(q.get(id).unwrap().state, JobState::Cancelled);
    }

    #[test]
    fn multi_job_fifo_order_and_cancelled_jobs_are_skipped() {
        let mut q = Queue::new();
        let a = q.push(convert("a.txt"));
        let b = q.push(convert("b.txt"));
        let c = q.push(revoice("c.taletrek"));

        assert_eq!(q.jobs().map(|j| j.id).collect::<Vec<_>>(), [a, b, c]);

        // Front of the queue is the oldest queued job.
        assert_eq!(q.next_job().unwrap().id, a);
        q.tick(QueueEvent::Started { id: a, total: 1 });

        // While a runs, b is next in line.
        assert_eq!(q.next_job().unwrap().id, b);
        // A second Started while a is running is refused — b stays Queued.
        q.tick(QueueEvent::Started { id: b, total: 1 });
        assert_eq!(q.get(b).unwrap().state, JobState::Queued);

        // b is cancelled while queued; c becomes next once a finishes.
        q.cancel(b);
        assert_eq!(q.next_job().unwrap().id, c);
        q.tick(QueueEvent::Finished {
            id: a,
            out: PathBuf::from("a.synth.taletrek"),
        });
        assert_eq!(q.next_job().unwrap().id, c);

        // Arrival order is preserved for rendering regardless of state.
        assert_eq!(q.jobs().map(|j| j.id).collect::<Vec<_>>(), [a, b, c]);
    }

    #[test]
    fn events_for_unknown_jobs_are_no_ops() {
        let mut q = Queue::new();
        let ghost = JobId(99);
        q.tick(QueueEvent::Started {
            id: ghost,
            total: 2,
        });
        q.tick(QueueEvent::Progress { id: ghost, done: 1 });
        q.tick(QueueEvent::Finished {
            id: ghost,
            out: PathBuf::from("ghost.taletrek"),
        });
        q.tick(QueueEvent::Failed {
            id: ghost,
            message: "boo".to_string(),
        });
        q.cancel(ghost);

        assert_eq!(q.jobs().count(), 0);
        assert!(q.get(ghost).is_none());
        assert!(q.next_job().is_none());
    }

    #[test]
    fn cancel_of_done_failed_or_cancelled_job_is_a_no_op() {
        let mut q = Queue::new();
        let done = q.push(convert("done.txt"));
        q.tick(QueueEvent::Started { id: done, total: 1 });
        let out = PathBuf::from("done.synth.taletrek");
        q.tick(QueueEvent::Finished {
            id: done,
            out: out.clone(),
        });
        q.cancel(done);
        assert_eq!(q.get(done).unwrap().state, JobState::Done(out));

        let failed = q.push(convert("failed.txt"));
        q.tick(QueueEvent::Started {
            id: failed,
            total: 1,
        });
        q.tick(QueueEvent::Failed {
            id: failed,
            message: "no".to_string(),
        });
        q.cancel(failed);
        assert_eq!(
            q.get(failed).unwrap().state,
            JobState::Failed("no".to_string())
        );

        let cancelled = q.push(convert("cancelled.txt"));
        q.cancel(cancelled);
        q.cancel(cancelled);
        assert_eq!(q.get(cancelled).unwrap().state, JobState::Cancelled);
    }

    #[test]
    fn cancel_of_queued_job_without_start_marks_cancelled() {
        let mut q = Queue::new();
        let id = q.push(convert("later.txt"));
        q.cancel(id);
        assert_eq!(q.get(id).unwrap().state, JobState::Cancelled);
        assert!(q.next_job().is_none(), "cancelled job never runs");
    }

    #[test]
    fn progress_is_clamped_to_total() {
        let mut q = Queue::new();
        let id = q.push(convert("clamp.txt"));
        q.tick(QueueEvent::Started { id, total: 3 });
        q.tick(QueueEvent::Progress { id, done: 7 });
        assert_eq!(
            q.get(id).unwrap().state,
            JobState::Running { done: 3, total: 3 }
        );
    }

    #[test]
    fn ids_are_fresh_and_distinct_across_pushes() {
        let mut q = Queue::new();
        let a = q.push(convert("a.txt"));
        let b = q.push(convert("b.txt"));
        assert_ne!(a, b);
    }
}
