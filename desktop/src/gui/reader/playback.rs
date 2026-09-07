//! The reader's playback controller (task 005): the kernel
//! [`PlayerState`] machine wired to the audio engine.
//!
//! UI-free by construction (no egui import) so the wiring is
//! headless-testable: user transport actions and engine completion
//! events both flow through [`PlayerState::tick`] (the only sequencing
//! authority — this controller adds none of its own), and the returned
//! [`PlayerAction`]s execute against an [`AudioTransport`] — the
//! engine in production, a scripted stub in tests.
//!
//! # The same-key re-load race (task 003's residual, closed here)
//!
//! Duplicate-text paragraphs share segment keys, so a stale
//! `SegmentDrained` for the paragraph the engine *was* on can arrive
//! right after the machine re-loaded identical content — and the
//! kernel's key check cannot tell it apart from the real drain. The
//! closure is the pending window: while a load is outstanding, this
//! controller drops completion events; the engine's `Loaded` ack
//! (emitted only after the new playhead is armed, and FIFO-ordered
//! after any pre-load completion because the engine thread is the sole
//! event sender) ends the window. A completion observed after the ack
//! can only belong to the new load. Task 003's note prescribed the
//! queue-clear; the ack is the airtight form of it (a bare clear can
//! still race a callback-side emission).

use taletrek_reader::{BookIndex, PlayerAction, PlayerEvent, PlayerState};

use super::audio::AudioEvent;

/// The audio engine as this controller sees it — the production
/// [`AudioEngine`](super::audio::AudioEngine) or a test stub. The
/// controller talks to the platform through exactly these three calls.
pub(crate) trait AudioTransport {
    /// Load and play `key`'s segment, starting `offset` seconds in.
    fn load(&self, key: &str, offset: f64);
    /// Silence output and drop the current segment.
    fn stop(&self);
    /// The next pending engine event, if any.
    fn try_event(&self) -> Option<AudioEvent>;
}

/// Kernel machine + engine + the pending-load window. The reader view
/// pumps this every frame and forwards button intents through
/// [`Playback::send`]; everything else is internal.
pub(crate) struct Playback {
    /// The sequencing machine (the kernel core — this type owns the
    /// only instance; the egui layer renders it and forwards events).
    state: PlayerState,
    /// The platform audio engine.
    transport: Box<dyn AudioTransport + Send>,
    /// The key of the outstanding load, until its `Loaded`/`Failed`
    /// report arrives (see the module docs — the race closure).
    pending: Option<String>,
    /// The current segment's decoded length in seconds — set by the
    /// load ack, cleared when a new load is commanded. Audio time is
    /// the platform's half of the kernel contract, and duration is its
    /// edge: the scrub range and the `offset / duration` readout.
    segment_duration: Option<f64>,
}

impl Playback {
    /// A resting controller over `transport`.
    pub(crate) fn new(transport: Box<dyn AudioTransport + Send>) -> Self {
        Self {
            state: PlayerState::idle(),
            transport,
            pending: None,
            segment_duration: None,
        }
    }

    /// The machine to render (transport bar, failure line, task 006's
    /// highlight).
    pub(crate) fn state(&self) -> &PlayerState {
        &self.state
    }

    /// The current segment's decoded length, once its load ack arrived
    /// (the scrub range / position readout; `None` while a load is in
    /// flight or after a failure — then the UI omits the denominator).
    pub(crate) fn segment_duration(&self) -> Option<f64> {
        self.segment_duration
    }

    /// A user transport action (a button): through the machine, then
    /// execute whatever the kernel orders.
    pub(crate) fn send(&mut self, ev: PlayerEvent, book: &BookIndex) {
        let (state, action) = self.state.clone().tick(ev, book);
        self.state = state;
        self.execute(action);
    }

    /// Drain engine events (once per frame). Completions go through
    /// the machine — the kernel absorbs stale keys — *unless* a load
    /// is pending (then they are pre-load stale and dropped here);
    /// ticks report audio time into the machine's `Playing` offset.
    pub(crate) fn pump(&mut self, book: &BookIndex) {
        while let Some(ev) = self.transport.try_event() {
            match ev {
                AudioEvent::Loaded { key, duration } => {
                    if self.pending.as_deref() == Some(key.as_str()) {
                        self.pending = None;
                        self.segment_duration = Some(duration);
                    }
                }
                AudioEvent::Drained { key } => {
                    if self.pending.is_none() {
                        self.send(PlayerEvent::SegmentDrained { key }, book);
                    }
                }
                AudioEvent::Failed { key, error } => {
                    let was_pending = self.pending.as_deref() == Some(key.as_str());
                    if was_pending {
                        self.pending = None;
                    }
                    if self.pending.is_none() {
                        self.send(PlayerEvent::SegmentFailed { key, error }, book);
                    }
                }
                AudioEvent::Tick { key, offset } => {
                    if self.pending.is_none() {
                        self.apply_tick(&key, offset, book);
                    }
                }
            }
        }
    }

    /// The platform's audio-time report: store `offset` into the
    /// machine's `Playing` record when `key` names the current
    /// segment. Audio time is the platform's half of the contract; the
    /// kernel holds it as data (there is no tick *event* to sequence —
    /// this is a field report, not a transition).
    fn apply_tick(&mut self, key: &str, offset: f64, book: &BookIndex) {
        if let PlayerState::Playing {
            para, offset: slot, ..
        } = &mut self.state
        {
            if book.paragraph(*para).is_some_and(|p| p.segment_key == key) {
                *slot = offset;
            }
        }
    }

    /// Execute a kernel action against the engine: a load opens the
    /// pending window; a stop closes it (the machine differentiates
    /// pause from book-end; the engine treats both as silence).
    fn execute(&mut self, action: PlayerAction) {
        match action {
            PlayerAction::LoadSegment { key, offset } => {
                self.pending = Some(key.clone());
                // The old segment's length no longer applies; the ack
                // re-establishes it.
                self.segment_duration = None;
                self.transport.load(&key, offset);
            }
            PlayerAction::Stop => {
                self.pending = None;
                self.transport.stop();
            }
            PlayerAction::None => {}
        }
    }
}

/// Test support shared with the view tests: the scripted transport and
/// the controller-over-script builder.
#[cfg(test)]
pub(crate) use tests::{controller, ScriptedTransport};

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use taletrek_reader::ParagraphPos;
    use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
    use taletrek_synth::{AudioCodec, ChapterText, Manifest, NORM_VERSION, SCHEMA_VERSION};

    use super::*;

    const VOICE: &str = "en_US-amy-medium";

    /// A scriptable stand-in for the engine: records executed commands,
    /// replays queued events. Shared with the view tests.
    pub(crate) struct ScriptedTransport {
        loads: Mutex<Vec<(String, f64)>>,
        stops: Mutex<usize>,
        events: Mutex<VecDeque<AudioEvent>>,
    }

    impl ScriptedTransport {
        pub(crate) fn new() -> Self {
            Self {
                loads: Mutex::new(Vec::new()),
                stops: Mutex::new(0),
                events: Mutex::new(VecDeque::new()),
            }
        }

        /// Queue an event for the next `pump`.
        pub(crate) fn push(&self, ev: AudioEvent) {
            self.events.lock().unwrap().push_back(ev);
        }

        /// The loads executed so far, in order: `(key, offset)`.
        pub(crate) fn loads(&self) -> Vec<(String, f64)> {
            self.loads.lock().unwrap().clone()
        }

        /// The stops executed so far.
        pub(crate) fn stops(&self) -> usize {
            *self.stops.lock().unwrap()
        }
    }

    impl AudioTransport for ScriptedTransport {
        fn load(&self, key: &str, offset: f64) {
            self.loads.lock().unwrap().push((key.to_owned(), offset));
        }

        fn stop(&self) {
            *self.stops.lock().unwrap() += 1;
        }

        fn try_event(&self) -> Option<AudioEvent> {
            self.events.lock().unwrap().pop_front()
        }
    }

    fn manifest(audio: bool) -> Manifest {
        Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_test".into(),
                title: "Test Book".into(),
                author: None,
                source_format: "txt".into(),
                chapter_count: 1,
                voice_id: VOICE.into(),
                created_at: 0,
                updated_at: 0,
                progress_fraction: None,
            },
            audio: AudioMeta {
                present: audio,
                codec: AudioCodec::Opus,
                norm_version: NORM_VERSION.parse().unwrap(),
                segment_count: 0,
            },
            generator: Generator {
                app: "taletrek-test".into(),
                version: "0.0.0".into(),
            },
        }
    }

    /// A one-chapter book over `texts` (duplicate strings intentionally
    /// share segment keys — the race fixture).
    fn book(texts: &[&str]) -> BookIndex {
        BookIndex::new(
            &manifest(true),
            &[ChapterText::new(
                "bk_test",
                0,
                "One",
                texts.iter().map(|t| (*t).to_owned()).collect(),
            )],
        )
    }

    fn key(book: &BookIndex, index: u32) -> String {
        book.paragraph(ParagraphPos::new(0, index))
            .unwrap()
            .segment_key
            .clone()
    }

    pub(crate) fn controller(transport: Arc<ScriptedTransport>) -> Playback {
        Playback::new(Box::new(ScriptShim(transport)))
    }

    /// A ScriptedTransport the controller can own a shared handle to.
    struct ScriptShim(Arc<ScriptedTransport>);

    impl AudioTransport for ScriptShim {
        fn load(&self, k: &str, o: f64) {
            self.0.load(k, o);
        }

        fn stop(&self) {
            self.0.stop();
        }

        fn try_event(&self) -> Option<AudioEvent> {
            self.0.try_event()
        }
    }

    fn playing_at(index: u32, offset: f64) -> PlayerState {
        PlayerState::Playing {
            para: ParagraphPos::new(0, index),
            offset,
            failures: Default::default(),
        }
    }

    #[test]
    fn play_starts_the_first_paragraph_and_loads_its_segment() {
        let book = book(&["One.", "Two."]);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        pb.send(PlayerEvent::Play, &book);

        assert_eq!(pb.state(), &playing_at(0, 0.0));
        assert_eq!(
            scripted.loads(),
            vec![(key(&book, 0), 0.0)],
            "the kernel's LoadSegment reaches the engine verbatim"
        );
    }

    #[test]
    fn pause_stops_output_and_play_resumes_at_the_last_reported_offset() {
        let book = book(&["One.", "Two."]);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        pb.send(PlayerEvent::Play, &book);
        scripted.push(AudioEvent::Loaded {
            key: key(&book, 0),
            duration: 9.0,
        });
        pb.pump(&book);
        scripted.push(AudioEvent::Tick {
            key: key(&book, 0),
            offset: 2.5,
        });
        pb.pump(&book);
        assert_eq!(pb.state(), &playing_at(0, 2.5));

        pb.send(PlayerEvent::Pause, &book);
        assert!(matches!(pb.state(), PlayerState::Paused { .. }));
        assert_eq!(scripted.stops(), 1);

        pb.send(PlayerEvent::Play, &book);
        assert_eq!(pb.state(), &playing_at(0, 2.5));
        assert_eq!(
            scripted.loads(),
            vec![(key(&book, 0), 0.0), (key(&book, 0), 2.5)],
            "resume reloads the segment at the recorded offset"
        );
    }

    #[test]
    fn ticks_only_update_the_offset_of_the_current_segment() {
        let book = book(&["One.", "Two."]);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        pb.send(PlayerEvent::Play, &book);
        scripted.push(AudioEvent::Loaded {
            key: key(&book, 0),
            duration: 9.0,
        });
        pb.pump(&book);

        scripted.push(AudioEvent::Tick {
            key: "some-other-key".into(),
            offset: 9.0,
        });
        pb.pump(&book);
        assert_eq!(pb.state(), &playing_at(0, 0.0), "foreign key ignored");

        scripted.push(AudioEvent::Tick {
            key: key(&book, 0),
            offset: 1.25,
        });
        pb.pump(&book);
        assert_eq!(pb.state(), &playing_at(0, 1.25));
    }

    #[test]
    fn drain_advances_to_the_next_paragraph_and_loads_it() {
        let book = book(&["One.", "Two."]);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        pb.send(PlayerEvent::Play, &book);
        scripted.push(AudioEvent::Loaded {
            key: key(&book, 0),
            duration: 9.0,
        });
        pb.pump(&book);
        scripted.push(AudioEvent::Drained { key: key(&book, 0) });
        pb.pump(&book);

        assert_eq!(pb.state(), &playing_at(1, 0.0));
        assert_eq!(
            scripted.loads(),
            vec![(key(&book, 0), 0.0), (key(&book, 1), 0.0)]
        );
    }

    #[test]
    fn the_final_drain_ends_the_book_with_a_stop() {
        let book = book(&["Only."]);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        pb.send(PlayerEvent::Play, &book);
        scripted.push(AudioEvent::Loaded {
            key: key(&book, 0),
            duration: 9.0,
        });
        pb.pump(&book);
        scripted.push(AudioEvent::Drained { key: key(&book, 0) });
        pb.pump(&book);

        assert!(matches!(pb.state(), PlayerState::Idle { .. }));
        assert_eq!(scripted.stops(), 1, "book end stops the engine");
    }

    /// The race task 003 flagged: duplicate-text paragraphs share keys,
    /// so a drain for the *old* load arriving between the re-load and
    /// its ack must be dropped — otherwise the machine double-advances
    /// (the key check alone cannot tell it apart from the real drain).
    #[test]
    fn a_stale_drain_racing_a_same_key_reload_is_dropped() {
        let book = book(&["Dup.", "Dup.", "Tail."]);
        let k0 = key(&book, 0);
        let k1 = key(&book, 1);
        assert_eq!(k0, k1, "fixture: duplicate text shares the key");

        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        pb.send(PlayerEvent::Play, &book);
        scripted.push(AudioEvent::Loaded {
            key: k0.clone(),
            duration: 9.0,
        });
        pb.pump(&book);

        // A normal advance to the (identical-key) second paragraph.
        scripted.push(AudioEvent::Drained { key: k0.clone() });
        pb.pump(&book);
        assert_eq!(pb.state(), &playing_at(1, 0.0));

        // The race: the old load's drain lands *after* the re-load was
        // commanded but *before* its ack. It must be dropped.
        scripted.push(AudioEvent::Drained { key: k0 });
        scripted.push(AudioEvent::Loaded {
            key: k1.clone(),
            duration: 9.0,
        });
        pb.pump(&book);
        assert_eq!(
            pb.state(),
            &playing_at(1, 0.0),
            "the stale same-key drain must not advance"
        );

        // The real drain of the new load advances exactly once.
        scripted.push(AudioEvent::Drained { key: k1 });
        pb.pump(&book);
        assert_eq!(pb.state(), &playing_at(2, 0.0));
        assert_eq!(
            scripted.loads(),
            vec![
                (key(&book, 0), 0.0),
                (key(&book, 1), 0.0),
                (key(&book, 2), 0.0)
            ],
            "three loads — no phantom fourth from the double advance"
        );
        assert_eq!(pb.state().failures(), &Default::default());
    }

    #[test]
    fn the_load_ack_establishes_the_segment_duration_until_the_next_load() {
        let book = book(&["One.", "Two."]);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        assert_eq!(pb.segment_duration(), None, "nothing loaded yet");

        pb.send(PlayerEvent::Play, &book);
        scripted.push(AudioEvent::Loaded {
            key: key(&book, 0),
            duration: 4.5,
        });
        pb.pump(&book);
        assert_eq!(pb.segment_duration(), Some(4.5));

        // Pause keeps the length — the paused readout still shows it.
        pb.send(PlayerEvent::Pause, &book);
        assert_eq!(pb.segment_duration(), Some(4.5));

        // Resuming commands a new load: the old length no longer
        // applies until this load's own ack lands.
        pb.send(PlayerEvent::Play, &book);
        assert_eq!(pb.segment_duration(), None, "cleared by the re-load");
        scripted.push(AudioEvent::Loaded {
            key: "some-other-key".into(),
            duration: 99.0,
        });
        pb.pump(&book);
        assert_eq!(pb.segment_duration(), None, "a foreign ack is not ours");
        scripted.push(AudioEvent::Loaded {
            key: key(&book, 0),
            duration: 3.0,
        });
        pb.pump(&book);
        assert_eq!(pb.segment_duration(), Some(3.0));
    }

    #[test]
    fn a_failed_segment_skips_the_paragraph_and_surfaces_via_the_log() {
        let book = book(&["One.", "Two."]);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        pb.send(PlayerEvent::Play, &book);
        // The load itself fails (missing/corrupt segment): Failed
        // arrives while pending and must be forwarded, not dropped.
        scripted.push(AudioEvent::Failed {
            key: key(&book, 0),
            error: "corrupt opus".into(),
        });
        pb.pump(&book);

        assert_eq!(
            pb.state(),
            &PlayerState::Playing {
                para: ParagraphPos::new(0, 1),
                offset: 0.0,
                failures: taletrek_reader::FailureLog {
                    skipped: 1,
                    last_error: Some("corrupt opus".into()),
                },
            }
        );
        assert_eq!(
            pb.state().failures().last_error.as_deref(),
            Some("corrupt opus")
        );
        assert_eq!(
            scripted.loads(),
            vec![(key(&book, 0), 0.0), (key(&book, 1), 0.0)],
            "playback continues on the skip path"
        );
    }

    #[test]
    fn a_stale_failure_for_another_pending_load_is_dropped() {
        let book = book(&["One.", "Two."]);
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        pb.send(PlayerEvent::Play, &book);
        pb.send(PlayerEvent::NextParagraph, &book);
        // Pending is now k1 (no ack scripted yet). A failure naming
        // anything else is pre-load stale: dropped, not forwarded.
        scripted.push(AudioEvent::Failed {
            key: "some-other-key".into(),
            error: "stale".into(),
        });
        pb.pump(&book);

        assert_eq!(pb.state(), &playing_at(1, 0.0), "no skip happened");
        assert_eq!(pb.state().failures().skipped, 0);
    }

    #[test]
    fn a_text_only_book_executes_nothing() {
        let quiet = book(&[]); // placeholder; real fixture below
        let _ = quiet;
        let quiet = BookIndex::new(
            &manifest(false),
            &[ChapterText::new("bk_test", 0, "One", vec!["Words.".into()])],
        );
        let scripted = Arc::new(ScriptedTransport::new());
        let mut pb = controller(scripted.clone());

        for ev in [
            PlayerEvent::Play,
            PlayerEvent::Pause,
            PlayerEvent::NextParagraph,
            PlayerEvent::NextChapter,
        ] {
            pb.send(ev, &quiet);
        }

        assert!(matches!(pb.state(), PlayerState::Idle { .. }));
        assert!(scripted.loads().is_empty());
        assert_eq!(scripted.stops(), 0);
    }
}
