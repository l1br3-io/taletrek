//! [`BookIndex`] — the navigable model over a bundle's manifest + chapters.

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
}
