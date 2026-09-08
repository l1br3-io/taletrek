//! [`Position`] — a durable reading position, and nothing else.
//!
//! The persistence half of the platform contract's position story: the
//! kernel already owns *where you are* (a [`PlayerState`]'s paragraph
//! and offset); this type is that answer as plain data — what a
//! platform writes when playback moves and what it hands back on open
//! to resume. Backend-agnostic by construction (no I/O, no storage, no
//! UI — the desktop persists it under egui storage keyed by
//! [`Position::storage_key`]; Android and iOS bring their own stores
//! over UniFFI later). Keying by the manifest's book id — not a file
//! path, not a voice — is what makes progress survive a moved file and
//! a re-voice: both keep the book, so both keep the place.
//!
//! Restore semantics: a loaded position seeds the machine **paused**
//! at the saved paragraph (a resume never auto-plays), with the offset
//! sanitized the way a scrub is (negative and non-finite land on zero)
//! and a fresh failure log — a resume is a new session.

use crate::state::{sanitize, ParagraphPos, PlayerState};

/// The prefix every persisted-position storage key carries — the
/// reader's slice of the `taletrek.*` storage namespace.
const KEY_PREFIX: &str = "taletrek.reader.position.";

/// A durable reading position: chapter and paragraph-within-chapter
/// indexes plus a seconds offset into that paragraph's segment —
/// plain data every platform (and UniFFI) can carry and store.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    /// Zero-based chapter index (reading order).
    pub chapter: u32,
    /// Zero-based paragraph index within the chapter.
    pub index: u32,
    /// Seconds into the paragraph's segment.
    pub offset: f64,
}

impl Position {
    /// Position `chapter`:`index`, `offset` seconds into the segment.
    #[must_use]
    pub fn new(chapter: u32, index: u32, offset: f64) -> Self {
        Self {
            chapter,
            index,
            offset,
        }
    }

    /// The paragraph this position names.
    #[must_use]
    pub fn paragraph(self) -> ParagraphPos {
        ParagraphPos::new(self.chapter, self.index)
    }

    /// The machine's current position as durable data — `None` at
    /// idle (a resting or finished book has nowhere to resume).
    #[must_use]
    pub fn capture(state: &PlayerState) -> Option<Self> {
        match state {
            PlayerState::Playing { para, offset, .. }
            | PlayerState::Paused { para, offset, .. } => Some(Self {
                chapter: para.chapter,
                index: para.index,
                offset: *offset,
            }),
            PlayerState::Idle { .. } => None,
        }
    }

    /// The restore seed: a machine paused at this position, offset
    /// sanitized (the scrub rule — the kernel does not know segment
    /// durations, so a hostile stored value only ever lands on zero),
    /// failure log fresh. Callers validate the paragraph against the
    /// book before seeding; this constructor stays pure data in, pure
    /// data out.
    #[must_use]
    pub fn restore_state(self) -> PlayerState {
        PlayerState::Paused {
            para: self.paragraph(),
            offset: sanitize(self.offset),
            failures: Default::default(),
        }
    }

    /// The per-book storage key: `taletrek.reader.position.<book_id>`.
    /// Derived from the manifest's book id so a moved file or a
    /// re-voiced bundle (same text, new voice) addresses the same
    /// slot.
    #[must_use]
    pub fn storage_key(book_id: &str) -> String {
        format!("{KEY_PREFIX}{book_id}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paused_at(chapter: u32, index: u32, offset: f64) -> PlayerState {
        PlayerState::Paused {
            para: ParagraphPos::new(chapter, index),
            offset,
            failures: Default::default(),
        }
    }

    #[test]
    fn storage_key_names_the_book_under_the_reader_namespace() {
        assert_eq!(
            Position::storage_key("bk_test"),
            "taletrek.reader.position.bk_test"
        );
        // Stability is the contract: the same id addresses the same
        // slot forever, distinct ids never collide.
        assert_eq!(
            Position::storage_key("bk_test"),
            Position::storage_key("bk_test")
        );
        assert_ne!(
            Position::storage_key("bk_test"),
            Position::storage_key("bk_other")
        );
    }

    #[test]
    fn capture_reads_playing_and_paused_but_not_idle() {
        let playing = PlayerState::Playing {
            para: ParagraphPos::new(2, 1),
            offset: 3.5,
            failures: Default::default(),
        };
        assert_eq!(Position::capture(&playing), Some(Position::new(2, 1, 3.5)));

        let paused = paused_at(0, 0, 9.25);
        assert_eq!(Position::capture(&paused), Some(Position::new(0, 0, 9.25)));

        // A resting book (never played, or finished) has no position.
        assert_eq!(Position::capture(&PlayerState::idle()), None);
        let finished = PlayerState::Idle {
            failures: crate::state::FailureLog {
                skipped: 2,
                last_error: Some("x".into()),
            },
        };
        assert_eq!(Position::capture(&finished), None);
    }

    #[test]
    fn restore_state_seeds_a_paused_machine_with_a_fresh_log() {
        let state = Position::new(1, 2, 4.5).restore_state();
        assert_eq!(state, paused_at(1, 2, 4.5));
        assert_eq!(state.failures(), &Default::default());
    }

    #[test]
    fn restore_state_sanitizes_hostile_offsets() {
        for raw in [-3.0, f64::NAN, f64::INFINITY] {
            let state = Position::new(0, 0, raw).restore_state();
            assert_eq!(state, paused_at(0, 0, 0.0), "raw {raw} must land on zero");
        }
    }

    #[test]
    fn capture_round_trips_through_restore_state() {
        for pos in [
            Position::new(0, 0, 0.0),
            Position::new(3, 7, 128.5),
            Position::new(u32::MAX, u32::MAX, 0.25),
        ] {
            assert_eq!(
                Position::capture(&pos.restore_state()),
                Some(pos),
                "round trip must preserve {pos:?}"
            );
        }
    }
}
