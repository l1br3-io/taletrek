//! Pure sync-UX helpers (task 006): the follow-vs-free scroll decision
//! and seek-target resolution, as free of egui as the state machine —
//! bools and kernel data in, bools out.
//!
//! # The follow-vs-free rule
//!
//! The pane *follows* playback by default: when the active paragraph
//! changes while following, it is scrolled into view (center) iff it
//! left the visible rect — the fill-down cadence. A user scrolling
//! elsewhere must not be hijacked, so following **pauses** the moment
//! the active paragraph leaves view *without* the paragraph having
//! changed (only a user scroll moves the viewport then — our own
//! follow scrolls always land with the paragraph in view). Following
//! **resumes** when the active paragraph re-enters view (the user
//! scrolled back to it) or when playback *seeks* — a user-initiated
//! position jump (paragraph click, outline, transport skips): the jump
//! re-anchors following and always brings the target into view. A
//! scrub is time-only (the paragraph does not move), so it deliberately
//! does not re-anchor. With no active paragraph (idle / text-only)
//! nothing follows anything and the flag rides along unchanged.

use taletrek_reader::{BookIndex, ParagraphPos};

/// One frame's facts for the follow decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FollowInput {
    /// The active paragraph changed since the last pane paint
    /// (playback advanced, or a seek landed).
    pub paragraph_changed: bool,
    /// A user-initiated position jump happened this frame (paragraph
    /// click, outline entry, transport skip) — the re-anchor.
    pub seek: bool,
    /// Whether any part of the active paragraph intersects the pane's
    /// visible rect; `None` when there is no active paragraph.
    pub active_in_view: Option<bool>,
    /// Whether the pane was following when the frame began.
    pub following: bool,
}

/// What the pane should do this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FollowDecision {
    /// Whether the pane follows playback going into the next frame.
    pub following: bool,
    /// Scroll the active paragraph into view (center) now.
    pub scroll_to_active: bool,
}

/// The follow-vs-free transition (see the module docs for the rule).
pub(crate) fn follow_decision(input: FollowInput) -> FollowDecision {
    let Some(in_view) = input.active_in_view else {
        // Nothing to follow — the flag rides along.
        return FollowDecision {
            following: input.following,
            scroll_to_active: false,
        };
    };
    if input.seek {
        // A seek re-anchors: follow again and show the target.
        return FollowDecision {
            following: true,
            scroll_to_active: true,
        };
    }
    if input.paragraph_changed {
        if input.following {
            // Natural advance while following: keep it in view.
            FollowDecision {
                following: true,
                scroll_to_active: !in_view,
            }
        } else {
            // Natural advance while the user reads elsewhere: leave
            // them alone.
            FollowDecision {
                following: false,
                scroll_to_active: false,
            }
        }
    } else if input.following && !in_view {
        // The paragraph didn't move but left view: the user scrolled —
        // stop following until they come back or playback seeks.
        FollowDecision {
            following: false,
            scroll_to_active: false,
        }
    } else if !input.following && in_view {
        // The active paragraph re-entered view: resume following.
        FollowDecision {
            following: true,
            scroll_to_active: false,
        }
    } else {
        FollowDecision {
            following: input.following,
            scroll_to_active: false,
        }
    }
}

/// Whether a transport event is a user-initiated *position jump* — the
/// re-anchoring kind of seek. Play/Pause and scrubs deliberately are
/// not: they move time or output, not position, and must not yank a
/// user who is reading elsewhere.
pub(crate) fn re_anchors(ev: &taletrek_reader::PlayerEvent) -> bool {
    use taletrek_reader::PlayerEvent;
    matches!(
        ev,
        PlayerEvent::SeekToParagraph(_)
            | PlayerEvent::NextParagraph
            | PlayerEvent::PrevParagraph
            | PlayerEvent::NextChapter
            | PlayerEvent::PrevChapter
    )
}

/// Where an outline entry for chapter `chapter` seeks: its first
/// paragraph. `None` for an empty or out-of-range chapter (the outline
/// then only switches the pane).
pub(crate) fn chapter_seek_target(book: &BookIndex, chapter: usize) -> Option<ParagraphPos> {
    let chapter = u32::try_from(chapter).ok()?;
    book.chapters
        .get(chapter as usize)?
        .paragraphs
        .first()
        .map(|_| ParagraphPos::new(chapter, 0))
}

/// The paragraph's book-wide 1-based ordinal `(n, N)` — the position
/// readout. `None` when `pos` does not name an existing paragraph (the
/// kernel's defensive stance, mirrored).
pub(crate) fn paragraph_ordinal(book: &BookIndex, pos: ParagraphPos) -> Option<(usize, usize)> {
    let chapter = usize::try_from(pos.chapter).ok()?;
    let index = usize::try_from(pos.index).ok()?;
    let before: usize = book
        .chapters
        .get(..chapter)?
        .iter()
        .map(|ch| ch.paragraphs.len())
        .sum();
    book.chapters.get(chapter)?.paragraphs.get(index)?;
    let total: usize = book.chapters.iter().map(|ch| ch.paragraphs.len()).sum();
    Some((before + index + 1, total))
}

#[cfg(test)]
mod tests {
    use taletrek_reader::ParagraphPos;
    use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
    use taletrek_synth::{AudioCodec, ChapterText, Manifest, NORM_VERSION, SCHEMA_VERSION};

    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_test".into(),
                title: "Test Book".into(),
                author: None,
                source_format: "txt".into(),
                chapter_count: 3,
                voice_id: "en_US-amy-medium".into(),
                created_at: 0,
                updated_at: 0,
                progress_fraction: None,
            },
            audio: AudioMeta {
                present: true,
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

    /// Chapter 0: two paragraphs, chapter 1: empty, chapter 2: one.
    fn book() -> BookIndex {
        BookIndex::new(
            &manifest(),
            &[
                ChapterText::new("bk_test", 0, "One", vec!["P0.".into(), "P1.".into()]),
                ChapterText::new("bk_test", 1, "Two", vec![]),
                ChapterText::new("bk_test", 2, "Three", vec!["P2.".into()]),
            ],
        )
    }

    fn input(following: bool, changed: bool, seek: bool, in_view: Option<bool>) -> FollowInput {
        FollowInput {
            paragraph_changed: changed,
            seek,
            active_in_view: in_view,
            following,
        }
    }

    #[test]
    fn natural_advance_while_following_scrolls_only_when_out_of_view() {
        let in_view = input(true, true, false, Some(true));
        assert_eq!(
            follow_decision(in_view),
            FollowDecision {
                following: true,
                scroll_to_active: false
            }
        );

        let out = input(true, true, false, Some(false));
        assert_eq!(
            follow_decision(out),
            FollowDecision {
                following: true,
                scroll_to_active: true
            }
        );
    }

    #[test]
    fn natural_advance_while_free_leaves_the_user_alone() {
        let free = input(false, true, false, Some(false));
        assert_eq!(
            follow_decision(free),
            FollowDecision {
                following: false,
                scroll_to_active: false
            }
        );
    }

    #[test]
    fn a_user_scroll_away_pauses_following() {
        // The paragraph didn't change but left view — only a user
        // scroll does that.
        let scrolled = input(true, false, false, Some(false));
        assert_eq!(
            follow_decision(scrolled),
            FollowDecision {
                following: false,
                scroll_to_active: false
            }
        );
    }

    #[test]
    fn the_active_paragraph_reentering_view_resumes_following() {
        let back = input(false, false, false, Some(true));
        assert_eq!(
            follow_decision(back),
            FollowDecision {
                following: true,
                scroll_to_active: false
            }
        );
    }

    #[test]
    fn a_seek_re_anchors_and_brings_the_target_into_view() {
        // Even from free mode, even when the paragraph did not change.
        let from_free = input(false, false, true, Some(false));
        assert_eq!(
            follow_decision(from_free),
            FollowDecision {
                following: true,
                scroll_to_active: true
            }
        );

        let while_following = input(true, true, true, Some(true));
        assert_eq!(
            follow_decision(while_following),
            FollowDecision {
                following: true,
                scroll_to_active: true
            }
        );
    }

    #[test]
    fn steady_states_are_inert() {
        for (following, in_view) in [(true, true), (false, false)] {
            let steady = input(following, false, false, Some(in_view));
            assert_eq!(
                follow_decision(steady),
                FollowDecision {
                    following,
                    scroll_to_active: false
                }
            );
        }
    }

    #[test]
    fn no_active_paragraph_changes_nothing() {
        for following in [true, false] {
            let idle = input(following, true, true, None);
            assert_eq!(
                follow_decision(idle),
                FollowDecision {
                    following,
                    scroll_to_active: false
                }
            );
        }
    }

    #[test]
    fn only_position_jumps_re_anchor_following() {
        use taletrek_reader::PlayerEvent;
        assert!(re_anchors(&PlayerEvent::SeekToParagraph(
            ParagraphPos::new(0, 0)
        )));
        assert!(re_anchors(&PlayerEvent::NextParagraph));
        assert!(re_anchors(&PlayerEvent::PrevParagraph));
        assert!(re_anchors(&PlayerEvent::NextChapter));
        assert!(re_anchors(&PlayerEvent::PrevChapter));
        assert!(!re_anchors(&PlayerEvent::Play));
        assert!(!re_anchors(&PlayerEvent::Pause));
        assert!(!re_anchors(&PlayerEvent::SeekWithinParagraph(1.0)));
    }

    #[test]
    fn chapter_seek_targets_first_paragraphs_and_skips_empty_chapters() {
        let book = book();
        assert_eq!(chapter_seek_target(&book, 0), Some(ParagraphPos::new(0, 0)));
        assert_eq!(
            chapter_seek_target(&book, 2),
            Some(ParagraphPos::new(2, 0)),
            "a non-empty chapter targets its first paragraph"
        );
        assert_eq!(
            chapter_seek_target(&book, 1),
            None,
            "an empty chapter has nothing to seek to"
        );
        assert_eq!(chapter_seek_target(&book, 99), None);
    }

    #[test]
    fn paragraph_ordinals_are_book_wide_and_one_based() {
        let book = book();
        assert_eq!(
            paragraph_ordinal(&book, ParagraphPos::new(0, 0)),
            Some((1, 3))
        );
        assert_eq!(
            paragraph_ordinal(&book, ParagraphPos::new(0, 1)),
            Some((2, 3))
        );
        // The empty chapter contributes nothing to the count.
        assert_eq!(
            paragraph_ordinal(&book, ParagraphPos::new(2, 0)),
            Some((3, 3))
        );
        // Invalid positions resolve to None, never a panic.
        assert_eq!(paragraph_ordinal(&book, ParagraphPos::new(1, 0)), None);
        assert_eq!(paragraph_ordinal(&book, ParagraphPos::new(0, 9)), None);
        assert_eq!(paragraph_ordinal(&book, ParagraphPos::new(9, 9)), None);
    }
}
