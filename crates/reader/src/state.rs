//! [`PlayerState`] — the pure playback sequencer.
//!
//! Platform contract (the anchor doc for every consumer — the desktop
//! now, Android and iOS via UniFFI in efforts 4–5): **the kernel owns
//! sequence and position; the platform owns audio time.** The core
//! decides *what plays next* and *where you are* — paragraph order,
//! chapter boundaries, book end, skip-on-failure. The platform decodes
//! the segment named by [`PlayerAction::LoadSegment`], drives output,
//! and reports completions back as [`PlayerEvent::SegmentDrained`] /
//! [`PlayerEvent::SegmentFailed`] — each tagged with the segment key it
//! belongs to, so a completion racing a user seek or pause is recognized
//! as stale and absorbed (platforms that report item-scoped endings —
//! Media3, AVFoundation — map onto the tag directly).
//!
//! Every transition is total and defensive, the `queue.rs` discipline: a
//! stale or out-of-order event is a no-op, an out-of-range target is a
//! no-op, a scrub offset is clamped at zero (no upper clamp — the kernel
//! does not know segment durations; audio time is the platform's), and a
//! text-only book (`!audio_present`) absorbs every event. `tick` never
//! panics.

use crate::index::BookIndex;

/// A paragraph's address — chapter index and paragraph-within-chapter
/// index, both zero-based. Plain `u32` data so every platform (and
/// UniFFI) can carry it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ParagraphPos {
    /// Zero-based chapter index (reading order, not the id string).
    pub chapter: u32,
    /// Zero-based paragraph index within the chapter.
    pub index: u32,
}

impl ParagraphPos {
    /// Address chapter `chapter`, paragraph `index`.
    #[must_use]
    pub fn new(chapter: u32, index: u32) -> Self {
        Self { chapter, index }
    }
}

/// Running record of skipped segments — the web-reader tolerance
/// (corrupt/missing audio must not stop the book), owned by the kernel so
/// every platform surfaces the same thing.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FailureLog {
    /// Segments skipped so far this session.
    pub skipped: u32,
    /// The most recent failure's message, if any.
    pub last_error: Option<String>,
}

impl FailureLog {
    /// One more skipped segment; `error` becomes the surfaced last error.
    fn recorded(&self, error: &str) -> Self {
        Self {
            skipped: self.skipped + 1,
            last_error: Some(error.to_owned()),
        }
    }
}

/// The one event type the machine understands — user transport actions
/// and platform completion callbacks, both applied via
/// [`PlayerState::tick`].
#[derive(Debug, Clone, PartialEq)]
pub enum PlayerEvent {
    /// Start playback (from idle: the book's first paragraph, fresh
    /// session; from paused: the recorded paragraph at the recorded
    /// offset).
    Play,
    /// Stop output, keep position.
    Pause,
    /// Skip to the next paragraph, crossing chapter boundaries.
    NextParagraph,
    /// Skip to the previous paragraph, crossing chapter boundaries.
    PrevParagraph,
    /// Jump to the next chapter's first paragraph.
    NextChapter,
    /// Jump to the previous chapter's first paragraph.
    PrevChapter,
    /// Jump to a paragraph (click-to-seek). From idle this starts
    /// playback at the target.
    SeekToParagraph(ParagraphPos),
    /// Scrub within the current paragraph (seconds into the segment);
    /// the platform restarts the segment at the decoded offset.
    SeekWithinParagraph(f64),
    /// The platform finished playing the segment keyed `key`. Stale by
    /// construction when it races a seek or pause — the tag lets the
    /// machine absorb it without double-advancing.
    SegmentDrained {
        /// The key of the segment that drained (the one the platform was
        /// last told to [`PlayerAction::LoadSegment`]).
        key: String,
    },
    /// The platform could not load or decode the segment keyed `key`
    /// (corrupt or missing audio): the machine skips that paragraph and
    /// continues, recording the failure.
    SegmentFailed {
        /// The key of the segment that failed.
        key: String,
        /// The platform's error message, surfaced via [`FailureLog`].
        error: String,
    },
}

/// Where playback is: resting, playing, or paused — always over the
/// current paragraph and a seconds offset into its segment, plus the
/// session's [`FailureLog`] (retrievable in every phase, so a finished
/// book can still say how many paragraphs it skipped).
#[derive(Debug, Clone, PartialEq)]
pub enum PlayerState {
    /// Not playing. Reached before the first `Play` and after the book
    /// ends (drain or failure at the last paragraph — a terminal stop,
    /// never a wrap).
    Idle {
        /// Skips from the session that just ended, if any.
        failures: FailureLog,
    },
    /// Playing `para`'s segment, `offset` seconds in.
    Playing {
        /// The current paragraph.
        para: ParagraphPos,
        /// Seconds into the paragraph's segment.
        offset: f64,
        /// The session's skip record.
        failures: FailureLog,
    },
    /// Suspended at `para`, `offset` seconds in.
    Paused {
        /// The current paragraph.
        para: ParagraphPos,
        /// Seconds into the paragraph's segment.
        offset: f64,
        /// The session's skip record.
        failures: FailureLog,
    },
}

/// What the platform should do after a transition — execute and render,
/// nothing more.
#[derive(Debug, Clone, PartialEq)]
pub enum PlayerAction {
    /// Nothing to do.
    None,
    /// Decode and start playing the segment keyed `key`, `offset`
    /// seconds in (scrub/resume semantics: restart at the decoded
    /// offset).
    LoadSegment {
        /// The segment to load — the current paragraph's
        /// [`crate::ParagraphIndex::segment_key`].
        key: String,
        /// Seconds into the segment to start at.
        offset: f64,
    },
    /// Stop output (pause, or the book finished).
    Stop,
}

impl PlayerState {
    /// The resting machine: nothing playing, nothing skipped.
    #[must_use]
    pub fn idle() -> Self {
        Self::Idle {
            failures: FailureLog::default(),
        }
    }

    /// The session's skip record, retrievable in every phase.
    #[must_use]
    pub fn failures(&self) -> &FailureLog {
        match self {
            Self::Idle { failures }
            | Self::Playing { failures, .. }
            | Self::Paused { failures, .. } => failures,
        }
    }

    /// Pure transition — platforms feed events, render the result.
    ///
    /// Total and defensive (see the module docs): text-only books absorb
    /// every event, unknown targets and stale completions are no-ops,
    /// and user skips out of range leave the state untouched. Only a
    /// drain or failure of the *current* segment advances past it; the
    /// last paragraph's drain (or failure) ends the book — terminal
    /// stop, no wrap.
    #[must_use]
    pub fn tick(self, ev: PlayerEvent, book: &BookIndex) -> (Self, PlayerAction) {
        // A text-only book has nothing to sequence: every event is a
        // no-op, the machine rests (the reader renders text and disables
        // the transport — the tolerance the web reader established).
        if !book.audio_present {
            return (self, PlayerAction::None);
        }

        match (self, ev) {
            // --- idle: only a start request can leave ------------------
            (Self::Idle { .. }, PlayerEvent::Play) => match book.first_paragraph() {
                Some(para) => (start_playing(para), load(book, para, 0.0)),
                None => (Self::idle(), PlayerAction::None),
            },
            (Self::Idle { .. }, PlayerEvent::SeekToParagraph(target)) => {
                match book.paragraph(target) {
                    Some(_) => (start_playing(target), load(book, target, 0.0)),
                    None => (Self::idle(), PlayerAction::None),
                }
            }
            (state @ Self::Idle { .. }, _) => (state, PlayerAction::None),

            // --- paused: resume, navigate, or record a scrub ------------
            (
                Self::Paused {
                    para,
                    offset,
                    failures,
                },
                PlayerEvent::Play,
            ) => {
                let action = load(book, para, offset);
                (
                    Self::Playing {
                        para,
                        offset,
                        failures,
                    },
                    action,
                )
            }
            (state @ Self::Paused { para, .. }, PlayerEvent::NextParagraph) => {
                user_move(book, state, book.next_paragraph(para))
            }
            (state @ Self::Paused { para, .. }, PlayerEvent::PrevParagraph) => {
                user_move(book, state, book.prev_paragraph(para))
            }
            (state @ Self::Paused { para, .. }, PlayerEvent::NextChapter) => {
                user_move(book, state, book.next_chapter_start(para))
            }
            (state @ Self::Paused { para, .. }, PlayerEvent::PrevChapter) => {
                user_move(book, state, book.prev_chapter_start(para))
            }
            (state @ Self::Paused { .. }, PlayerEvent::SeekToParagraph(target))
                if book.paragraph(target).is_some() =>
            {
                user_move(book, state, Some(target))
            }
            (state @ Self::Paused { .. }, PlayerEvent::SeekToParagraph(_)) => {
                (state, PlayerAction::None)
            }
            (Self::Paused { para, failures, .. }, PlayerEvent::SeekWithinParagraph(raw)) => (
                Self::Paused {
                    para,
                    offset: sanitize(raw),
                    failures,
                },
                PlayerAction::None,
            ),
            // Pause-while-paused, and completions that raced the pause:
            // playback is suspended, drains and failures are stale.
            (state @ Self::Paused { .. }, PlayerEvent::Pause) => (state, PlayerAction::None),
            (state @ Self::Paused { .. }, PlayerEvent::SegmentDrained { .. }) => {
                (state, PlayerAction::None)
            }
            (state @ Self::Paused { .. }, PlayerEvent::SegmentFailed { .. }) => {
                (state, PlayerAction::None)
            }

            // --- playing: navigate, scrub, or follow the platform -------
            (state @ Self::Playing { .. }, PlayerEvent::Play) => (state, PlayerAction::None),
            (
                Self::Playing {
                    para,
                    offset,
                    failures,
                },
                PlayerEvent::Pause,
            ) => (
                Self::Paused {
                    para,
                    offset,
                    failures,
                },
                PlayerAction::Stop,
            ),
            (state @ Self::Playing { para, .. }, PlayerEvent::NextParagraph) => {
                user_move(book, state, book.next_paragraph(para))
            }
            (state @ Self::Playing { para, .. }, PlayerEvent::PrevParagraph) => {
                user_move(book, state, book.prev_paragraph(para))
            }
            (state @ Self::Playing { para, .. }, PlayerEvent::NextChapter) => {
                user_move(book, state, book.next_chapter_start(para))
            }
            (state @ Self::Playing { para, .. }, PlayerEvent::PrevChapter) => {
                user_move(book, state, book.prev_chapter_start(para))
            }
            (state @ Self::Playing { .. }, PlayerEvent::SeekToParagraph(target))
                if book.paragraph(target).is_some() =>
            {
                user_move(book, state, Some(target))
            }
            (Self::Playing { para, failures, .. }, PlayerEvent::SeekWithinParagraph(raw)) => {
                let offset = sanitize(raw);
                (
                    Self::Playing {
                        para,
                        offset,
                        failures,
                    },
                    load(book, para, offset),
                )
            }
            (Self::Playing { para, failures, .. }, PlayerEvent::SegmentDrained { key })
                if is_current(book, para, &key) =>
            {
                advance_after(book, para, failures)
            }
            (Self::Playing { para, failures, .. }, PlayerEvent::SegmentFailed { key, error })
                if is_current(book, para, &key) =>
            {
                advance_after(book, para, failures.recorded(&error))
            }
            // Completions naming any other segment are stale (they raced
            // a seek) — absorbed, never a double-advance.
            (state @ Self::Playing { .. }, PlayerEvent::SeekToParagraph(_)) => {
                (state, PlayerAction::None)
            }
            (state @ Self::Playing { .. }, PlayerEvent::SegmentDrained { .. }) => {
                (state, PlayerAction::None)
            }
            (state @ Self::Playing { .. }, PlayerEvent::SegmentFailed { .. }) => {
                (state, PlayerAction::None)
            }
        }
    }
}

/// A fresh playing session at `para`'s start — the failure log resets
/// with it.
fn start_playing(para: ParagraphPos) -> PlayerState {
    PlayerState::Playing {
        para,
        offset: 0.0,
        failures: FailureLog::default(),
    }
}

/// User navigation (next/prev paragraph + chapter, click-to-seek): move
/// to `target` when it exists, restarting the segment; an out-of-range
/// target leaves the state untouched. Playing reloads at the new segment;
/// Paused only records the move.
fn user_move(
    book: &BookIndex,
    from: PlayerState,
    target: Option<ParagraphPos>,
) -> (PlayerState, PlayerAction) {
    let Some(target) = target else {
        return (from, PlayerAction::None);
    };
    match from {
        PlayerState::Playing { failures, .. } => {
            let state = PlayerState::Playing {
                para: target,
                offset: 0.0,
                failures,
            };
            let action = load(book, target, 0.0);
            (state, action)
        }
        PlayerState::Paused { failures, .. } => (
            PlayerState::Paused {
                para: target,
                offset: 0.0,
                failures,
            },
            PlayerAction::None,
        ),
        PlayerState::Idle { .. } => (from, PlayerAction::None),
    }
}

/// Platform continuation (the current segment drained or failed): advance
/// to the next paragraph and keep playing; at book end, finish with a
/// terminal stop — never a wrap.
fn advance_after(
    book: &BookIndex,
    from: ParagraphPos,
    failures: FailureLog,
) -> (PlayerState, PlayerAction) {
    match book.next_paragraph(from) {
        Some(target) => {
            let state = PlayerState::Playing {
                para: target,
                offset: 0.0,
                failures,
            };
            let action = load(book, target, 0.0);
            (state, action)
        }
        None => (PlayerState::Idle { failures }, PlayerAction::Stop),
    }
}

/// The platform's load instruction for `para`'s segment at `offset` —
/// `None` if the paragraph doesn't resolve (defensive; callers validate).
fn load(book: &BookIndex, para: ParagraphPos, offset: f64) -> PlayerAction {
    book.paragraph(para)
        .map(|p| PlayerAction::LoadSegment {
            key: p.segment_key.clone(),
            offset,
        })
        .unwrap_or(PlayerAction::None)
}

/// Whether `key` names `para`'s segment — the stale-completion check.
fn is_current(book: &BookIndex, para: ParagraphPos, key: &str) -> bool {
    book.paragraph(para).is_some_and(|p| p.segment_key == key)
}

/// Scrub offsets clamp at zero and non-finite values land on zero; there
/// is no upper clamp because the kernel doesn't know segment durations —
/// audio time is the platform's (the contract). Shared by scrubs and
/// [`crate::Position`] restores: a hostile stored offset only ever
/// lands on zero.
pub(crate) fn sanitize(offset: f64) -> f64 {
    if offset.is_finite() && offset > 0.0 {
        offset
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
    use taletrek_synth::{AudioCodec, ChapterText, Manifest, NORM_VERSION, SCHEMA_VERSION};

    use super::*;

    const VOICE: &str = "en_US-lessac-medium";

    fn manifest(audio_present: bool) -> Manifest {
        Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_test".into(),
                title: "Test Book".into(),
                author: None,
                source_format: "txt".into(),
                chapter_count: 3,
                voice_id: VOICE.into(),
                created_at: 0,
                updated_at: 0,
                progress_fraction: None,
            },
            audio: AudioMeta {
                present: audio_present,
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

    /// Chapter 0 has two paragraphs, chapter 1 is empty (must be skipped
    /// by all navigation), chapter 2 has the book's last paragraph.
    fn chapters() -> Vec<ChapterText> {
        vec![
            ChapterText::new("bk_test", 0, "One", vec!["P0.".into(), "P1.".into()]),
            ChapterText::new("bk_test", 1, "Two", vec![]),
            ChapterText::new("bk_test", 2, "Three", vec!["P2.".into()]),
        ]
    }

    fn book(audio: bool) -> BookIndex {
        BookIndex::new(&manifest(audio), &chapters())
    }

    fn pos(chapter: u32, index: u32) -> ParagraphPos {
        ParagraphPos::new(chapter, index)
    }

    fn key(book: &BookIndex, at: ParagraphPos) -> String {
        book.paragraph(at).unwrap().segment_key.clone()
    }

    fn playing_at(chapter: u32, index: u32, offset: f64) -> PlayerState {
        PlayerState::Playing {
            para: pos(chapter, index),
            offset,
            failures: FailureLog::default(),
        }
    }

    fn paused_at(chapter: u32, index: u32, offset: f64) -> PlayerState {
        PlayerState::Paused {
            para: pos(chapter, index),
            offset,
            failures: FailureLog::default(),
        }
    }

    // --- play / pause -------------------------------------------------

    #[test]
    fn play_from_idle_starts_at_the_first_paragraph() {
        let book = book(true);
        let (state, action) = PlayerState::idle().tick(PlayerEvent::Play, &book);
        assert_eq!(state, playing_at(0, 0, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(0, 0)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn play_from_an_empty_book_is_a_noop() {
        let book = BookIndex::new(&manifest(true), &[]);
        let (state, action) = PlayerState::idle().tick(PlayerEvent::Play, &book);
        assert_eq!(state, PlayerState::idle());
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn play_from_only_empty_chapters_is_a_noop() {
        let empty = vec![
            ChapterText::new("bk_test", 0, "One", vec![]),
            ChapterText::new("bk_test", 1, "Two", vec![]),
        ];
        let book = BookIndex::new(&manifest(true), &empty);
        let (state, action) = PlayerState::idle().tick(PlayerEvent::Play, &book);
        assert_eq!(state, PlayerState::idle());
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn play_starts_a_fresh_session_resetting_the_failure_log() {
        let book = book(true);
        let idle = PlayerState::Idle {
            failures: FailureLog {
                skipped: 2,
                last_error: Some("stale".into()),
            },
        };
        let (state, _) = idle.tick(PlayerEvent::Play, &book);
        assert_eq!(state.failures(), &FailureLog::default());
    }

    #[test]
    fn pause_stops_output_and_keeps_position() {
        let book = book(true);
        let (state, action) = playing_at(0, 1, 1.25).tick(PlayerEvent::Pause, &book);
        assert_eq!(state, paused_at(0, 1, 1.25));
        assert_eq!(action, PlayerAction::Stop);
    }

    #[test]
    fn pause_is_a_noop_when_idle_or_already_paused() {
        let book = book(true);
        let (state, action) = PlayerState::idle().tick(PlayerEvent::Pause, &book);
        assert_eq!(state, PlayerState::idle());
        assert_eq!(action, PlayerAction::None);

        let (state, action) = paused_at(0, 0, 2.0).tick(PlayerEvent::Pause, &book);
        assert_eq!(state, paused_at(0, 0, 2.0));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn play_from_paused_resumes_at_the_recorded_offset() {
        let book = book(true);
        let (state, action) = paused_at(2, 0, 3.5).tick(PlayerEvent::Play, &book);
        assert_eq!(state, playing_at(2, 0, 3.5));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(2, 0)),
                offset: 3.5
            }
        );
    }

    #[test]
    fn play_while_playing_is_a_noop() {
        let book = book(true);
        let (state, action) = playing_at(0, 1, 1.0).tick(PlayerEvent::Play, &book);
        assert_eq!(state, playing_at(0, 1, 1.0));
        assert_eq!(action, PlayerAction::None);
    }

    // --- paragraph navigation ------------------------------------------

    #[test]
    fn next_paragraph_moves_within_the_chapter() {
        let book = book(true);
        let (state, action) = playing_at(0, 0, 4.0).tick(PlayerEvent::NextParagraph, &book);
        assert_eq!(state, playing_at(0, 1, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(0, 1)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn next_paragraph_crosses_into_the_next_nonempty_chapter() {
        let book = book(true);
        let (state, action) = playing_at(0, 1, 2.0).tick(PlayerEvent::NextParagraph, &book);
        assert_eq!(state, playing_at(2, 0, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(2, 0)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn next_paragraph_at_book_end_is_a_noop() {
        let book = book(true);
        let (state, action) = playing_at(2, 0, 4.0).tick(PlayerEvent::NextParagraph, &book);
        assert_eq!(state, playing_at(2, 0, 4.0));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn prev_paragraph_moves_within_the_chapter() {
        let book = book(true);
        let (state, action) = playing_at(0, 1, 3.0).tick(PlayerEvent::PrevParagraph, &book);
        assert_eq!(state, playing_at(0, 0, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(0, 0)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn prev_paragraph_crosses_to_the_previous_chapters_last_paragraph() {
        let book = book(true);
        let (state, action) = playing_at(2, 0, 1.0).tick(PlayerEvent::PrevParagraph, &book);
        assert_eq!(state, playing_at(0, 1, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(0, 1)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn prev_paragraph_at_book_start_is_a_noop() {
        let book = book(true);
        let (state, action) = playing_at(0, 0, 1.5).tick(PlayerEvent::PrevParagraph, &book);
        assert_eq!(state, playing_at(0, 0, 1.5));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn paragraph_skips_while_paused_move_without_loading() {
        let book = book(true);
        let (state, action) = paused_at(0, 0, 1.0).tick(PlayerEvent::NextParagraph, &book);
        assert_eq!(state, paused_at(0, 1, 0.0));
        assert_eq!(action, PlayerAction::None);

        let (state, action) = paused_at(2, 0, 0.5).tick(PlayerEvent::PrevParagraph, &book);
        assert_eq!(state, paused_at(0, 1, 0.0));
        assert_eq!(action, PlayerAction::None);
    }

    // --- chapter navigation --------------------------------------------

    #[test]
    fn next_chapter_jumps_to_the_next_nonempty_chapter_start() {
        let book = book(true);
        let (state, action) = playing_at(0, 0, 0.0).tick(PlayerEvent::NextChapter, &book);
        assert_eq!(state, playing_at(2, 0, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(2, 0)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn next_chapter_in_the_last_chapter_is_a_noop() {
        let book = book(true);
        let (state, action) = playing_at(2, 0, 1.0).tick(PlayerEvent::NextChapter, &book);
        assert_eq!(state, playing_at(2, 0, 1.0));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn prev_chapter_jumps_to_the_previous_chapter_start() {
        let book = book(true);
        let (state, action) = playing_at(2, 0, 2.0).tick(PlayerEvent::PrevChapter, &book);
        assert_eq!(state, playing_at(0, 0, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(0, 0)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn prev_chapter_in_the_first_chapter_is_a_noop() {
        let book = book(true);
        let (state, action) = playing_at(0, 1, 0.5).tick(PlayerEvent::PrevChapter, &book);
        assert_eq!(state, playing_at(0, 1, 0.5));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn chapter_skips_while_paused_move_without_loading() {
        let book = book(true);
        let (state, action) = paused_at(2, 0, 1.0).tick(PlayerEvent::PrevChapter, &book);
        assert_eq!(state, paused_at(0, 0, 0.0));
        assert_eq!(action, PlayerAction::None);
    }

    // --- seeks -----------------------------------------------------------

    #[test]
    fn seek_to_paragraph_from_idle_starts_playback_there() {
        let book = book(true);
        let (state, action) =
            PlayerState::idle().tick(PlayerEvent::SeekToParagraph(pos(2, 0)), &book);
        assert_eq!(state, playing_at(2, 0, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(2, 0)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn seek_to_paragraph_from_playing_loads_the_target() {
        let book = book(true);
        let (state, action) =
            playing_at(0, 0, 1.0).tick(PlayerEvent::SeekToParagraph(pos(2, 0)), &book);
        assert_eq!(state, playing_at(2, 0, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(2, 0)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn seek_to_paragraph_from_paused_moves_without_playing() {
        let book = book(true);
        let (state, action) =
            paused_at(0, 0, 9.0).tick(PlayerEvent::SeekToParagraph(pos(0, 1)), &book);
        assert_eq!(state, paused_at(0, 1, 0.0));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn seek_to_unknown_targets_is_a_noop_in_every_mode() {
        let book = book(true);
        // Out-of-range chapter, out-of-range index, and the empty
        // chapter (it has no addressable paragraphs).
        for target in [pos(9, 0), pos(0, 9), pos(1, 0)] {
            for state in [
                PlayerState::idle(),
                playing_at(0, 0, 1.0),
                paused_at(0, 0, 1.0),
            ] {
                let (next, action) = state
                    .clone()
                    .tick(PlayerEvent::SeekToParagraph(target), &book);
                assert_eq!(next, state, "target {target:?} must not move {state:?}");
                assert_eq!(action, PlayerAction::None);
            }
        }
    }

    #[test]
    fn seek_within_paragraph_updates_the_offset_and_reloads_from_it() {
        let book = book(true);
        let (state, action) =
            playing_at(0, 1, 0.0).tick(PlayerEvent::SeekWithinParagraph(2.5), &book);
        assert_eq!(state, playing_at(0, 1, 2.5));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(0, 1)),
                offset: 2.5
            }
        );
    }

    #[test]
    fn seek_within_paragraph_clamps_negative_and_nonfinite_to_zero() {
        let book = book(true);
        for raw in [-3.0, f64::NAN, f64::INFINITY] {
            let (state, action) =
                playing_at(0, 1, 1.0).tick(PlayerEvent::SeekWithinParagraph(raw), &book);
            assert_eq!(state, playing_at(0, 1, 0.0), "raw {raw} must clamp to zero");
            assert_eq!(
                action,
                PlayerAction::LoadSegment {
                    key: key(&book, pos(0, 1)),
                    offset: 0.0
                }
            );
        }
    }

    #[test]
    fn seek_within_paragraph_while_paused_records_only() {
        let book = book(true);
        let (state, action) =
            paused_at(0, 1, 1.0).tick(PlayerEvent::SeekWithinParagraph(2.0), &book);
        assert_eq!(state, paused_at(0, 1, 2.0));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn seek_within_paragraph_while_idle_is_a_noop() {
        let book = book(true);
        let (state, action) =
            PlayerState::idle().tick(PlayerEvent::SeekWithinParagraph(1.0), &book);
        assert_eq!(state, PlayerState::idle());
        assert_eq!(action, PlayerAction::None);
    }

    // --- drains ----------------------------------------------------------

    #[test]
    fn drain_advances_to_the_next_paragraph() {
        let book = book(true);
        let (state, action) = playing_at(0, 0, 0.0).tick(
            PlayerEvent::SegmentDrained {
                key: key(&book, pos(0, 0)),
            },
            &book,
        );
        assert_eq!(state, playing_at(0, 1, 0.0));
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(0, 1)),
                offset: 0.0
            }
        );
    }

    #[test]
    fn drain_at_book_end_finishes_with_a_terminal_stop() {
        let book = book(true);
        let (state, action) = playing_at(2, 0, 0.0).tick(
            PlayerEvent::SegmentDrained {
                key: key(&book, pos(2, 0)),
            },
            &book,
        );
        assert_eq!(state, PlayerState::idle());
        assert_eq!(action, PlayerAction::Stop);
    }

    #[test]
    fn drain_after_pause_is_absorbed_without_advancing() {
        let book = book(true);
        // The platform finished the segment in the same instant the user
        // paused: pause wins, the drain cannot advance or corrupt.
        let (paused, _) = playing_at(0, 0, 0.0).tick(PlayerEvent::Pause, &book);
        let (state, action) = paused.tick(
            PlayerEvent::SegmentDrained {
                key: key(&book, pos(0, 0)),
            },
            &book,
        );
        assert_eq!(state, paused_at(0, 0, 0.0));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn stale_drain_after_a_seek_cannot_double_advance() {
        let book = book(true);
        // Seek away, then the old segment's drain arrives late: the key
        // no longer names the current paragraph, so it is absorbed.
        let (sought, _) =
            playing_at(0, 0, 0.0).tick(PlayerEvent::SeekToParagraph(pos(2, 0)), &book);
        let (state, action) = sought.tick(
            PlayerEvent::SegmentDrained {
                key: key(&book, pos(0, 0)),
            },
            &book,
        );
        assert_eq!(state, playing_at(2, 0, 0.0));
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn drain_while_idle_is_a_noop() {
        let book = book(true);
        let (state, action) = PlayerState::idle().tick(
            PlayerEvent::SegmentDrained {
                key: key(&book, pos(0, 0)),
            },
            &book,
        );
        assert_eq!(state, PlayerState::idle());
        assert_eq!(action, PlayerAction::None);
    }

    // --- failures ----------------------------------------------------------

    #[test]
    fn segment_failure_skips_the_paragraph_and_continues() {
        let book = book(true);
        let (state, action) = playing_at(0, 0, 0.0).tick(
            PlayerEvent::SegmentFailed {
                key: key(&book, pos(0, 0)),
                error: "corrupt opus".into(),
            },
            &book,
        );
        assert_eq!(
            state,
            PlayerState::Playing {
                para: pos(0, 1),
                offset: 0.0,
                failures: FailureLog {
                    skipped: 1,
                    last_error: Some("corrupt opus".into()),
                },
            }
        );
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(0, 1)),
                offset: 0.0
            }
        );
        assert_eq!(state.failures().skipped, 1);
        assert_eq!(state.failures().last_error.as_deref(), Some("corrupt opus"));
    }

    #[test]
    fn consecutive_failures_keep_advancing_and_counting() {
        let book = book(true);
        let (state, _) = playing_at(0, 0, 0.0).tick(
            PlayerEvent::SegmentFailed {
                key: key(&book, pos(0, 0)),
                error: "first".into(),
            },
            &book,
        );
        let (state, action) = state.tick(
            PlayerEvent::SegmentFailed {
                key: key(&book, pos(0, 1)),
                error: "second".into(),
            },
            &book,
        );
        assert_eq!(
            state,
            PlayerState::Playing {
                para: pos(2, 0),
                offset: 0.0,
                failures: FailureLog {
                    skipped: 2,
                    last_error: Some("second".into()),
                },
            }
        );
        assert_eq!(
            action,
            PlayerAction::LoadSegment {
                key: key(&book, pos(2, 0)),
                offset: 0.0
            }
        );
        assert_eq!(state.failures().skipped, 2);
        assert_eq!(state.failures().last_error.as_deref(), Some("second"));
    }

    #[test]
    fn failure_at_book_end_finishes_with_the_log_still_surfaceable() {
        let book = book(true);
        let (state, action) = playing_at(2, 0, 0.0).tick(
            PlayerEvent::SegmentFailed {
                key: key(&book, pos(2, 0)),
                error: "missing".into(),
            },
            &book,
        );
        assert_eq!(
            state,
            PlayerState::Idle {
                failures: FailureLog {
                    skipped: 1,
                    last_error: Some("missing".into())
                }
            }
        );
        assert_eq!(action, PlayerAction::Stop);
        assert_eq!(state.failures().skipped, 1);
    }

    #[test]
    fn stale_failure_after_a_seek_is_absorbed() {
        let book = book(true);
        let (sought, _) =
            playing_at(0, 0, 0.0).tick(PlayerEvent::SeekToParagraph(pos(2, 0)), &book);
        let (state, action) = sought.tick(
            PlayerEvent::SegmentFailed {
                key: key(&book, pos(0, 0)),
                error: "stale".into(),
            },
            &book,
        );
        assert_eq!(state, playing_at(2, 0, 0.0));
        assert_eq!(state.failures(), &FailureLog::default());
        assert_eq!(action, PlayerAction::None);
    }

    #[test]
    fn failure_while_paused_or_idle_is_a_noop() {
        let book = book(true);
        for state in [paused_at(0, 0, 0.0), PlayerState::idle()] {
            let (next, action) = state.clone().tick(
                PlayerEvent::SegmentFailed {
                    key: key(&book, pos(0, 0)),
                    error: "x".into(),
                },
                &book,
            );
            assert_eq!(next, state);
            assert_eq!(action, PlayerAction::None);
        }
    }

    // --- text-only tolerance ---------------------------------------------

    #[test]
    fn text_only_book_absorbs_every_event() {
        let quiet = book(false);
        let loud = book(true);
        let events = vec![
            PlayerEvent::Play,
            PlayerEvent::Pause,
            PlayerEvent::NextParagraph,
            PlayerEvent::PrevParagraph,
            PlayerEvent::NextChapter,
            PlayerEvent::PrevChapter,
            PlayerEvent::SeekToParagraph(pos(0, 0)),
            PlayerEvent::SeekToParagraph(pos(9, 9)),
            PlayerEvent::SeekWithinParagraph(1.0),
            PlayerEvent::SegmentDrained {
                key: key(&loud, pos(0, 0)),
            },
            PlayerEvent::SegmentFailed {
                key: key(&loud, pos(0, 0)),
                error: "x".into(),
            },
        ];
        for state in [
            PlayerState::idle(),
            playing_at(0, 0, 0.0),
            paused_at(0, 0, 1.0),
        ] {
            for ev in &events {
                let (next, action) = state.clone().tick(ev.clone(), &quiet);
                assert_eq!(next, state, "{ev:?} must be a no-op on a text-only book");
                assert_eq!(action, PlayerAction::None);
            }
        }
    }

    // --- totality -----------------------------------------------------------

    #[test]
    fn every_state_x_event_transition_is_total() {
        let book = book(true);
        let events = vec![
            PlayerEvent::Play,
            PlayerEvent::Pause,
            PlayerEvent::NextParagraph,
            PlayerEvent::PrevParagraph,
            PlayerEvent::NextChapter,
            PlayerEvent::PrevChapter,
            PlayerEvent::SeekToParagraph(pos(0, 0)),
            PlayerEvent::SeekToParagraph(pos(u32::MAX, u32::MAX)),
            PlayerEvent::SeekWithinParagraph(0.0),
            PlayerEvent::SeekWithinParagraph(f64::NAN),
            PlayerEvent::SeekWithinParagraph(-1.0),
            PlayerEvent::SegmentDrained {
                key: "k_unknown".into(),
            },
            PlayerEvent::SegmentFailed {
                key: String::new(),
                error: String::new(),
            },
        ];
        for state in [
            PlayerState::idle(),
            playing_at(0, 0, 0.0),
            playing_at(2, 0, 9.0),
            paused_at(0, 1, 1.0),
        ] {
            for ev in &events {
                // The assertion is survival: tick must return, not panic.
                let _ = state.clone().tick(ev.clone(), &book);
            }
        }
    }
}
