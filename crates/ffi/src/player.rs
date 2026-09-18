//! [`TrekPlayer`] — the playback sequencer as a UniFFI object.
//!
//! The enum-ergonomics mitigation from the plan: `PlayerState` is a
//! by-value enum the foreign side would have to thread through every
//! transition, so the object holds the state (and the book it sequences
//! against) internally and exposes total methods — platforms feed
//! [`FfiPlayerEvent`]s, execute the returned [`FfiPlayerAction`]s, render
//! [`FfiStateSnapshot`]s. `PlayerState` never crosses as a by-value enum;
//! the kernel, not Kotlin/Swift, decides what plays next.

use std::sync::Mutex;

use taletrek_reader::{
    BookIndex, FailureLog, ParagraphPos, PlayerAction, PlayerEvent, PlayerState, Position,
};

use crate::book::{book_index_from, FfiBook};

/// A paragraph's address — chapter index and paragraph-within-chapter
/// index, both zero-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct FfiParagraphPos {
    /// Zero-based chapter index (reading order, not the id string).
    pub chapter: u32,
    /// Zero-based paragraph index within the chapter.
    pub index: u32,
}

/// A durable reading position — what a platform stores when playback
/// moves and hands back on open to resume.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct FfiPosition {
    /// Zero-based chapter index (reading order).
    pub chapter: u32,
    /// Zero-based paragraph index within the chapter.
    pub index: u32,
    /// Seconds into the paragraph's segment.
    pub offset: f64,
}

/// Running record of skipped segments, retrievable in every phase.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FfiFailureLog {
    /// Segments skipped so far this session.
    pub skipped: u32,
    /// The most recent failure's message, if any.
    pub last_error: Option<String>,
}

/// Where playback is — always paired with the snapshot's para/offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FfiPlayerStatus {
    /// Not playing: before the first `Play` and after the book ends.
    Idle,
    /// Playing the current paragraph's segment.
    Playing,
    /// Suspended at the current paragraph.
    Paused,
}

/// The renderable state of a [`TrekPlayer`] — status, current paragraph,
/// offset into its segment, and the session's failure log.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FfiStateSnapshot {
    /// Where playback is.
    pub status: FfiPlayerStatus,
    /// The current paragraph, if any (`None` at idle).
    pub para: Option<FfiParagraphPos>,
    /// Seconds into the current paragraph's segment (0.0 at idle).
    pub offset: f64,
    /// The session's skip record.
    pub failures: FfiFailureLog,
}

/// The one event type the machine understands — user transport actions
/// and platform completion callbacks.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum FfiPlayerEvent {
    /// Start playback (from idle: the first paragraph, fresh session;
    /// from paused: the recorded paragraph at the recorded offset).
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
    SeekToParagraph {
        /// The target paragraph.
        pos: FfiParagraphPos,
    },
    /// Scrub within the current paragraph (seconds into the segment).
    SeekWithinParagraph {
        /// Seconds into the segment.
        offset: f64,
    },
    /// The platform finished playing the segment keyed `key`.
    SegmentDrained {
        /// The key of the segment that drained.
        key: String,
    },
    /// The platform could not load or decode the segment keyed `key` —
    /// the machine skips that paragraph and continues.
    SegmentFailed {
        /// The key of the segment that failed.
        key: String,
        /// The platform's error message.
        error: String,
    },
}

/// What the platform should do after a transition — execute and render,
/// nothing more.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum FfiPlayerAction {
    /// Nothing to do.
    None,
    /// Decode and start playing the segment keyed `key`, `offset`
    /// seconds in.
    LoadSegment {
        /// The segment to load.
        key: String,
        /// Seconds into the segment to start at.
        offset: f64,
    },
    /// Stop output (pause, or the book finished).
    Stop,
}

/// The kernel's player as foreign callers hold it — one per open book,
/// owning the [`BookIndex`] and the [`PlayerState`] it sequences.
///
/// The platform contract verbatim: feed it events, execute the returned
/// actions, render the snapshots. Sequencing never leaves Rust.
#[derive(uniffi::Object)]
pub struct TrekPlayer {
    book: BookIndex,
    state: Mutex<PlayerState>,
}

#[uniffi::export]
impl TrekPlayer {
    /// A resting player over `book` — nothing playing, nothing skipped.
    #[uniffi::constructor]
    pub fn new(book: FfiBook) -> Self {
        Self {
            book: playable_index(&book),
            state: Mutex::new(PlayerState::idle()),
        }
    }

    /// A player restored at `position`: paused at the saved paragraph
    /// with a fresh failure log (a resume is a new session, never an
    /// auto-play). A position whose paragraph does not validate against
    /// the book seeds fresh idle — no phantom resume.
    #[uniffi::constructor]
    pub fn restore(book: FfiBook, position: FfiPosition) -> Self {
        let index = playable_index(&book);
        let pos = Position::from(position);
        // The one sanctioned branch (restore-validation glue —
        // `position.rs`'s callers-validate contract).
        let state = if index.paragraph(pos.paragraph()).is_some() {
            pos.restore_state()
        } else {
            PlayerState::idle()
        };
        Self {
            book: index,
            state: Mutex::new(state),
        }
    }

    /// One pure transition: apply `event`, get back what to do.
    pub fn tick(&self, event: FfiPlayerEvent) -> FfiPlayerAction {
        let mut state = self.state.lock().expect("player state lock poisoned");
        let (next, action) = state.clone().tick(event.into(), &self.book);
        *state = next;
        action.into()
    }

    /// The renderable state right now.
    pub fn state_snapshot(&self) -> FfiStateSnapshot {
        snapshot_of(&self.state.lock().expect("player state lock poisoned"))
    }

    /// The durable position right now — `None` at idle (a resting or
    /// finished book has nowhere to resume).
    pub fn position(&self) -> Option<FfiPosition> {
        Position::capture(&self.state.lock().expect("player state lock poisoned")).map(Into::into)
    }
}

/// The player's view of a book. A text-only bundle whose host registered
/// a segment store upgrades to playable: the manifest lacks the audio,
/// the store supplies it (progressive fill). Everything else maps
/// verbatim.
fn playable_index(book: &FfiBook) -> BookIndex {
    let mut index = book_index_from(book);
    if !index.audio_present && crate::book::segment_store_registered() {
        index.audio_present = true;
    }
    index
}

/// The per-book storage key for a durable position:
/// `taletrek.reader.position.<book_id>`. Derived from the manifest's
/// book id so a moved file or a re-voiced bundle addresses the same
/// slot.
#[uniffi::export]
pub fn position_storage_key(book_id: String) -> String {
    Position::storage_key(&book_id)
}

impl From<FfiParagraphPos> for ParagraphPos {
    fn from(pos: FfiParagraphPos) -> Self {
        Self::new(pos.chapter, pos.index)
    }
}

impl From<ParagraphPos> for FfiParagraphPos {
    fn from(pos: ParagraphPos) -> Self {
        Self {
            chapter: pos.chapter,
            index: pos.index,
        }
    }
}

impl From<FfiPosition> for Position {
    fn from(pos: FfiPosition) -> Self {
        Self::new(pos.chapter, pos.index, pos.offset)
    }
}

impl From<Position> for FfiPosition {
    fn from(pos: Position) -> Self {
        Self {
            chapter: pos.chapter,
            index: pos.index,
            offset: pos.offset,
        }
    }
}

impl From<FailureLog> for FfiFailureLog {
    fn from(log: FailureLog) -> Self {
        Self {
            skipped: log.skipped,
            last_error: log.last_error,
        }
    }
}

impl From<FfiPlayerEvent> for PlayerEvent {
    fn from(event: FfiPlayerEvent) -> Self {
        match event {
            FfiPlayerEvent::Play => Self::Play,
            FfiPlayerEvent::Pause => Self::Pause,
            FfiPlayerEvent::NextParagraph => Self::NextParagraph,
            FfiPlayerEvent::PrevParagraph => Self::PrevParagraph,
            FfiPlayerEvent::NextChapter => Self::NextChapter,
            FfiPlayerEvent::PrevChapter => Self::PrevChapter,
            FfiPlayerEvent::SeekToParagraph { pos } => Self::SeekToParagraph(pos.into()),
            FfiPlayerEvent::SeekWithinParagraph { offset } => Self::SeekWithinParagraph(offset),
            FfiPlayerEvent::SegmentDrained { key } => Self::SegmentDrained { key },
            FfiPlayerEvent::SegmentFailed { key, error } => Self::SegmentFailed { key, error },
        }
    }
}

impl From<PlayerAction> for FfiPlayerAction {
    fn from(action: PlayerAction) -> Self {
        match action {
            PlayerAction::None => Self::None,
            PlayerAction::LoadSegment { key, offset } => Self::LoadSegment { key, offset },
            PlayerAction::Stop => Self::Stop,
        }
    }
}

/// The renderable snapshot of one machine state.
fn snapshot_of(state: &PlayerState) -> FfiStateSnapshot {
    match state {
        PlayerState::Idle { failures } => FfiStateSnapshot {
            status: FfiPlayerStatus::Idle,
            para: None,
            offset: 0.0,
            failures: failures.clone().into(),
        },
        PlayerState::Playing {
            para,
            offset,
            failures,
        }
        | PlayerState::Paused {
            para,
            offset,
            failures,
        } => FfiStateSnapshot {
            status: if matches!(state, PlayerState::Playing { .. }) {
                FfiPlayerStatus::Playing
            } else {
                FfiPlayerStatus::Paused
            },
            para: Some((*para).into()),
            offset: *offset,
            failures: failures.clone().into(),
        },
    }
}
