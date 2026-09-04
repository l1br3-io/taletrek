//! The GUI's [`ProgressSink`]: worker progress forwarded into a
//! crossbeam channel the egui thread drains each frame.
//!
//! The job thread's engine calls ([`ProgressSink::synth_step`] /
//! [`ProgressSink::download_step`]) happen on rayon worker threads; the GUI
//! owns the [`Queue`](super::queue::Queue) and may only be touched from the
//! egui thread. This sink is the bridge: it translates worker callbacks into
//! [`WorkerMsg`]s and sends them (unbounded, never blocking) into the channel
//! the executor drains with `try_recv` on every frame.
//!
//! Sends are best-effort (`let _ =`): the only failure mode is the receiving
//! GUI being gone (window closed mid-job), where silently finishing the
//! paragraph is exactly right — mirroring [`Progress`]'s swallow-errors rule.

use crossbeam_channel::Sender;

use taletrek_worker::ProgressSink;

use super::queue::{JobId, QueueEvent};

/// One message from a job thread to the GUI thread.
///
/// Queue lifecycle changes travel as [`QueueEvent`]s (applied via
/// [`Queue::tick`](super::queue::Queue::tick) — the only queue transition);
/// the other variants are render-only ephemera the queue deliberately does
/// not model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerMsg {
    /// A queue state transition (Started/Progress/Finished/Failed) for
    /// [`Queue::tick`](super::queue::Queue::tick).
    Event(QueueEvent),

    /// Voice-model download progress (bytes) — shown next to the running
    /// job, not queue state.
    Download {
        /// Bytes fetched so far.
        done: u64,
        /// Total bytes (`0` = unknown `Content-Length`).
        total: u64,
    },

    /// The job's thread has finished (its last message, sent on every exit
    /// path — success, failure, panic). The executor uses this to clear its
    /// thread bookkeeping and admit the next job.
    Exited(JobId),
}

/// A [`ProgressSink`] that forwards worker callbacks into `tx` as
/// [`WorkerMsg`]s, tagged with the job they belong to.
///
/// One sink is constructed per job thread and shared by reference into voice
/// resolution (download progress) and the synth pool (paragraph progress) —
/// `Send + Sync` by construction (`Sender` is both).
pub struct ChannelSink {
    /// Where the messages go (the executor's channel).
    tx: Sender<WorkerMsg>,
    /// The job this sink reports for.
    job: JobId,
}

impl ChannelSink {
    /// Build the sink for `job`, sending into `tx`.
    pub fn new(tx: Sender<WorkerMsg>, job: JobId) -> Self {
        Self { tx, job }
    }
}

impl ProgressSink for ChannelSink {
    /// Forward a completed paragraph as a [`QueueEvent::Progress`] for this
    /// job. `total` is dropped — the queue fixed it at
    /// [`QueueEvent::Started`] and clamps `done` itself.
    fn synth_step(&self, done: usize, _total: usize) {
        let _ = self.tx.send(WorkerMsg::Event(QueueEvent::Progress {
            id: self.job,
            done,
        }));
    }

    /// Forward voice-model download bytes as a [`WorkerMsg::Download`].
    fn download_step(&self, done: u64, total: u64) {
        let _ = self.tx.send(WorkerMsg::Download { done, total });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crossbeam_channel::unbounded;

    #[test]
    fn synth_step_maps_to_a_progress_event_tagged_with_the_job() {
        let (tx, rx) = unbounded();
        let sink = ChannelSink::new(tx, JobId::for_test(7));

        sink.synth_step(1, 4);
        sink.synth_step(3, 4);

        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Event(QueueEvent::Progress {
                id: JobId::for_test(7),
                done: 1
            })
        );
        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Event(QueueEvent::Progress {
                id: JobId::for_test(7),
                done: 3
            })
        );
        assert!(
            rx.try_recv().is_err(),
            "total is dropped, nothing else sent"
        );
    }

    #[test]
    fn download_step_maps_to_a_download_message_verbatim() {
        let (tx, rx) = unbounded();
        let sink = ChannelSink::new(tx, JobId::for_test(1));

        sink.download_step(1024 * 1024, 0);
        sink.download_step(2 * 1024 * 1024, 63 * 1024 * 1024);

        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Download {
                done: 1024 * 1024,
                total: 0
            }
        );
        assert_eq!(
            rx.try_recv().unwrap(),
            WorkerMsg::Download {
                done: 2 * 1024 * 1024,
                total: 63 * 1024 * 1024
            }
        );
    }
}
