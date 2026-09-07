//! [`BookIndex`] — the navigable model over a bundle's manifest + chapters.

use crate::state::ParagraphPos;
use taletrek_synth::{cache_key, ChapterText, Manifest};

/// A book's navigable structure: chapters, paragraphs, and per-paragraph
/// segment keys — the model readers render and sequence against.
#[derive(Debug, Clone, PartialEq)]
pub struct BookIndex {
    /// Book id (`bk_…`).
    pub book_id: String,
    /// Book title.
    pub title: String,
    /// Whether the source bundle carries audio segments.
    pub audio_present: bool,
    /// Chapters in reading order.
    pub chapters: Vec<ChapterIndex>,
}

/// One chapter of a [`BookIndex`].
#[derive(Debug, Clone, PartialEq)]
pub struct ChapterIndex {
    /// Chapter id (`ch_…`).
    pub id: String,
    /// Chapter title.
    pub title: String,
    /// Paragraphs in reading order.
    pub paragraphs: Vec<ParagraphIndex>,
}

/// One paragraph of a [`ChapterIndex`].
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphIndex {
    /// Positional id — `${chapterId}:${index}`, mirroring the web reader's
    /// paragraph-id scheme.
    pub id: String,
    /// The paragraph's text.
    pub text: String,
    /// Content-addressed segment key for this paragraph — the same
    /// derivation the writer used when keying `audio/` entries.
    pub segment_key: String,
}

impl BookIndex {
    /// Build the index from a bundle's manifest and chapter text.
    ///
    /// Total: an empty book or empty chapters produce empty structures, no
    /// panic.
    #[must_use]
    pub fn new(manifest: &Manifest, chapters: &[ChapterText]) -> Self {
        let voice = manifest.book.voice_id.as_str();
        Self {
            book_id: manifest.book.id.clone(),
            title: manifest.book.title.clone(),
            audio_present: manifest.audio.present,
            chapters: chapters
                .iter()
                .map(|ch| ChapterIndex {
                    id: ch.id.clone(),
                    title: ch.title.clone(),
                    paragraphs: ch
                        .paragraphs
                        .iter()
                        .enumerate()
                        .map(|(i, text)| ParagraphIndex {
                            id: format!("{}:{i}", ch.id),
                            text: text.clone(),
                            segment_key: cache_key(voice, text),
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

/// Reading-order navigation over a [`BookIndex`] — the sequencing
/// primitives [`crate::PlayerState`] ticks against (and the outline
/// renders from). Empty chapters have no addressable paragraphs, so every
/// walk skips them; every method is total (out-of-range positions yield
/// `None`, never a panic).
impl BookIndex {
    /// The paragraph at `pos`, if it exists — validates both the chapter
    /// and the paragraph-within-chapter index.
    #[must_use]
    pub fn paragraph(&self, pos: ParagraphPos) -> Option<&ParagraphIndex> {
        let (chapter, index) = self.coordinates(pos)?;
        self.chapters.get(chapter)?.paragraphs.get(index)
    }

    /// The book's first paragraph, skipping leading empty chapters.
    /// `None` when the book has no paragraphs at all.
    #[must_use]
    pub fn first_paragraph(&self) -> Option<ParagraphPos> {
        let (chapter, _) = self
            .chapters
            .iter()
            .enumerate()
            .find(|(_, ch)| !ch.paragraphs.is_empty())?;
        Some(ParagraphPos::new(u32::try_from(chapter).ok()?, 0))
    }

    /// The paragraph after `pos` in reading order, crossing chapter
    /// boundaries (empty chapters are skipped). `None` at book end.
    #[must_use]
    pub fn next_paragraph(&self, pos: ParagraphPos) -> Option<ParagraphPos> {
        let (chapter, index) = self.coordinates(pos)?;
        if index + 1 < self.chapters[chapter].paragraphs.len() {
            return Some(ParagraphPos::new(
                pos.chapter,
                u32::try_from(index + 1).ok()?,
            ));
        }
        self.chapter_start_after(chapter)
    }

    /// The paragraph before `pos` in reading order, crossing chapter
    /// boundaries (empty chapters are skipped). `None` at book start.
    #[must_use]
    pub fn prev_paragraph(&self, pos: ParagraphPos) -> Option<ParagraphPos> {
        let (chapter, index) = self.coordinates(pos)?;
        if index > 0 {
            return Some(ParagraphPos::new(
                pos.chapter,
                u32::try_from(index - 1).ok()?,
            ));
        }
        let (prev_c, prev_ch) = self.chapters[..chapter]
            .iter()
            .enumerate()
            .rev()
            .find(|(_, ch)| !ch.paragraphs.is_empty())?;
        let last = prev_ch.paragraphs.len() - 1;
        Some(ParagraphPos::new(
            u32::try_from(prev_c).ok()?,
            u32::try_from(last).ok()?,
        ))
    }

    /// The first paragraph of the next non-empty chapter after `pos`'s
    /// chapter. `None` when `pos` sits in the last chapter (or nowhere).
    #[must_use]
    pub fn next_chapter_start(&self, pos: ParagraphPos) -> Option<ParagraphPos> {
        let (chapter, _) = self.coordinates(pos)?;
        self.chapter_start_after(chapter)
    }

    /// The first paragraph of the nearest previous non-empty chapter.
    /// `None` when `pos` sits in the first chapter (or nowhere).
    #[must_use]
    pub fn prev_chapter_start(&self, pos: ParagraphPos) -> Option<ParagraphPos> {
        let (chapter, _) = self.coordinates(pos)?;
        let (prev_c, _) = self.chapters[..chapter]
            .iter()
            .enumerate()
            .rev()
            .find(|(_, ch)| !ch.paragraphs.is_empty())?;
        Some(ParagraphPos::new(u32::try_from(prev_c).ok()?, 0))
    }

    /// `(chapter, paragraph)` indexes for a validated position — the
    /// position must name a paragraph that actually exists.
    fn coordinates(&self, pos: ParagraphPos) -> Option<(usize, usize)> {
        let chapter = usize::try_from(pos.chapter).ok()?;
        let index = usize::try_from(pos.index).ok()?;
        self.chapters.get(chapter)?.paragraphs.get(index)?;
        Some((chapter, index))
    }

    /// The first paragraph of the first non-empty chapter strictly after
    /// chapter `after`.
    fn chapter_start_after(&self, after: usize) -> Option<ParagraphPos> {
        self.chapters
            .iter()
            .enumerate()
            .skip(after + 1)
            .find(|(_, ch)| !ch.paragraphs.is_empty())
            .and_then(|(chapter, _)| Some(ParagraphPos::new(u32::try_from(chapter).ok()?, 0)))
    }
}

#[cfg(test)]
mod tests {
    use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
    use taletrek_synth::{
        cache_key, AudioCodec, ChapterText, Manifest, NORM_VERSION, SCHEMA_VERSION,
    };

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
                chapter_count: 2,
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

    fn chapters() -> Vec<ChapterText> {
        vec![
            ChapterText::new("bk_test", 0, "One", vec!["First.".into(), "Second.".into()]),
            ChapterText::new("bk_test", 1, "Two", vec!["Third.".into()]),
        ]
    }

    #[test]
    fn builds_chapters_paragraphs_and_keys() {
        let index = BookIndex::new(&manifest(true), &chapters());
        assert_eq!(index.book_id, "bk_test");
        assert_eq!(index.title, "Test Book");
        assert!(index.audio_present);
        assert_eq!(index.chapters.len(), 2);

        let ch0 = &index.chapters[0];
        assert_eq!(ch0.id, "ch_bk_test_0");
        assert_eq!(ch0.title, "One");
        assert_eq!(ch0.paragraphs.len(), 2);

        // Paragraph ids mirror the web reader's `${chapterId}:${index}`.
        let p01 = &ch0.paragraphs[1];
        assert_eq!(p01.id, "ch_bk_test_0:1");
        assert_eq!(p01.text, "Second.");

        // Segment keys derive from the manifest voice over the paragraph text.
        assert_eq!(p01.segment_key, cache_key(VOICE, "Second."));

        let ch1 = &index.chapters[1];
        assert_eq!(ch1.paragraphs[0].id, "ch_bk_test_1:0");
        assert_eq!(ch1.paragraphs[0].segment_key, cache_key(VOICE, "Third."));
    }

    #[test]
    fn audio_present_flag_follows_the_manifest() {
        let index = BookIndex::new(&manifest(false), &chapters());
        assert!(!index.audio_present);
    }

    #[test]
    fn empty_chapter_contributes_no_paragraphs() {
        let mut chs = chapters();
        chs.insert(1, ChapterText::new("bk_test", 1, "Empty", vec![]));
        let index = BookIndex::new(&manifest(true), &chs);
        assert_eq!(index.chapters.len(), 3);
        assert!(index.chapters[1].paragraphs.is_empty());
    }

    #[test]
    fn empty_book_is_empty_but_total() {
        let index = BookIndex::new(&manifest(true), &[]);
        assert_eq!(index.book_id, "bk_test");
        assert!(index.chapters.is_empty());
    }

    // --- navigation ------------------------------------------------------

    fn pos(chapter: u32, index: u32) -> ParagraphPos {
        ParagraphPos::new(chapter, index)
    }

    /// Chapters 0 and 2 have paragraphs; chapters 1 (middle) and 3
    /// (trailing) are empty and must be skipped by every walk.
    fn nav_book() -> BookIndex {
        let chapters = vec![
            ChapterText::new("bk_test", 0, "One", vec!["P0.".into(), "P1.".into()]),
            ChapterText::new("bk_test", 1, "Two", vec![]),
            ChapterText::new("bk_test", 2, "Three", vec!["P2.".into()]),
            ChapterText::new("bk_test", 3, "Four", vec![]),
        ];
        BookIndex::new(&manifest(true), &chapters)
    }

    #[test]
    fn paragraph_lookup_validates_chapter_and_index() {
        let book = nav_book();
        assert!(book.paragraph(pos(0, 0)).is_some());
        assert!(book.paragraph(pos(0, 1)).is_some());
        assert!(book.paragraph(pos(2, 0)).is_some());
        // Empty chapter, out-of-range chapter, out-of-range index, huge
        // values — all None, no panic.
        assert!(book.paragraph(pos(1, 0)).is_none());
        assert!(book.paragraph(pos(4, 0)).is_none());
        assert!(book.paragraph(pos(0, 2)).is_none());
        assert!(book.paragraph(pos(u32::MAX, u32::MAX)).is_none());
    }

    #[test]
    fn first_paragraph_skips_leading_empty_chapters() {
        let book = nav_book();
        assert_eq!(book.first_paragraph(), Some(pos(0, 0)));

        let chapters = vec![
            ChapterText::new("bk_test", 0, "Empty", vec![]),
            ChapterText::new("bk_test", 1, "Full", vec!["Late.".into()]),
        ];
        let led = BookIndex::new(&manifest(true), &chapters);
        assert_eq!(led.first_paragraph(), Some(pos(1, 0)));
    }

    #[test]
    fn next_paragraph_walks_and_crosses_skipping_empty_chapters() {
        let book = nav_book();
        assert_eq!(book.next_paragraph(pos(0, 0)), Some(pos(0, 1)));
        assert_eq!(book.next_paragraph(pos(0, 1)), Some(pos(2, 0)));
        // Book end — the trailing empty chapter is not a stop.
        assert_eq!(book.next_paragraph(pos(2, 0)), None);
    }

    #[test]
    fn prev_paragraph_walks_and_crosses_skipping_empty_chapters() {
        let book = nav_book();
        assert_eq!(book.prev_paragraph(pos(2, 0)), Some(pos(0, 1)));
        assert_eq!(book.prev_paragraph(pos(0, 1)), Some(pos(0, 0)));
        assert_eq!(book.prev_paragraph(pos(0, 0)), None);
    }

    #[test]
    fn chapter_starts_target_nonempty_chapters_only() {
        let book = nav_book();
        assert_eq!(book.next_chapter_start(pos(0, 1)), Some(pos(2, 0)));
        assert_eq!(book.next_chapter_start(pos(2, 0)), None);
        assert_eq!(book.prev_chapter_start(pos(2, 0)), Some(pos(0, 0)));
        assert_eq!(book.prev_chapter_start(pos(0, 1)), None);
        // Invalid positions have no chapter to navigate from.
        assert_eq!(book.next_chapter_start(pos(9, 9)), None);
        assert_eq!(book.prev_chapter_start(pos(9, 9)), None);
    }

    #[test]
    fn empty_book_has_no_navigation() {
        let book = BookIndex::new(&manifest(true), &[]);
        let anywhere = pos(0, 0);
        assert_eq!(book.first_paragraph(), None);
        assert_eq!(book.next_paragraph(anywhere), None);
        assert_eq!(book.prev_paragraph(anywhere), None);
        assert_eq!(book.next_chapter_start(anywhere), None);
        assert_eq!(book.prev_chapter_start(anywhere), None);
    }
}
