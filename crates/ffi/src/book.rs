//! Book opening over the FFI surface — bundle path in, flattened records
//! out. Audio is never touched on open (G27's lesson applies to phone RAM
//! budgets more than anywhere): segments stream per paragraph via
//! [`read_segment`].

use std::path::Path;

use taletrek_reader::{BookIndex, ChapterIndex, ParagraphIndex};
use taletrek_synth::{read_audio_segment, read_book_metadata};

use crate::error::FfiError;

/// One paragraph as foreign callers see it — the reader's
/// [`ParagraphIndex`] flattened.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiParagraph {
    /// Positional id — `${chapterId}:${index}`, mirroring the web
    /// reader's paragraph-id scheme.
    pub id: String,
    /// The paragraph's text.
    pub text: String,
    /// Content-addressed segment key for this paragraph.
    pub segment_key: String,
}

/// One chapter as foreign callers see it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiChapter {
    /// Chapter id (`ch_…`).
    pub id: String,
    /// Chapter title.
    pub title: String,
    /// Paragraphs in reading order.
    pub paragraphs: Vec<FfiParagraph>,
}

/// A whole book as foreign callers see it — manifest display data plus
/// the navigable chapter/paragraph structure the UI renders against.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiBook {
    /// Book id (`bk_…`) — the key positions and libraries key by.
    pub book_id: String,
    /// Book title.
    pub title: String,
    /// Whether the bundle carries audio segments.
    pub audio_present: bool,
    /// Chapters in reading order.
    pub chapters: Vec<FfiChapter>,
}

/// Open the `.taletrek` bundle at `path`: manifest + chapter text in, the
/// flattened navigable book out. The `audio/` entries are never scanned
/// or decompressed.
#[uniffi::export]
pub fn open_book(path: String) -> Result<FfiBook, FfiError> {
    let (manifest, chapters) = read_book_metadata(Path::new(&path))?;
    Ok(BookIndex::new(&manifest, &chapters).into())
}

/// Read one audio segment's bytes from the bundle at `path` — the
/// single-entry disk read, verbatim. `None` when the archive carries no
/// segment for `key` (including every key on a text-only bundle).
#[uniffi::export]
pub fn read_segment(path: String, key: String) -> Result<Option<Vec<u8>>, FfiError> {
    Ok(read_audio_segment(Path::new(&path), &key)?.map(|seg| seg.bytes))
}

/// Rebuild the kernel's [`BookIndex`] from the flattened records — the
/// player's construction path. Field-for-field: the segment keys were
/// derived by the kernel on the way out, so they ride back unchanged.
pub(crate) fn book_index_from(book: &FfiBook) -> BookIndex {
    BookIndex {
        book_id: book.book_id.clone(),
        title: book.title.clone(),
        audio_present: book.audio_present,
        chapters: book
            .chapters
            .iter()
            .map(|ch| ChapterIndex {
                id: ch.id.clone(),
                title: ch.title.clone(),
                paragraphs: ch
                    .paragraphs
                    .iter()
                    .map(|p| ParagraphIndex {
                        id: p.id.clone(),
                        text: p.text.clone(),
                        segment_key: p.segment_key.clone(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

impl From<BookIndex> for FfiBook {
    fn from(index: BookIndex) -> Self {
        Self {
            book_id: index.book_id,
            title: index.title,
            audio_present: index.audio_present,
            chapters: index.chapters.iter().map(flat_chapter).collect(),
        }
    }
}

/// Flatten one [`ParagraphIndex`].
fn flat_paragraph(p: &ParagraphIndex) -> FfiParagraph {
    FfiParagraph {
        id: p.id.clone(),
        text: p.text.clone(),
        segment_key: p.segment_key.clone(),
    }
}

/// Flatten one [`ChapterIndex`].
fn flat_chapter(c: &ChapterIndex) -> FfiChapter {
    FfiChapter {
        id: c.id.clone(),
        title: c.title.clone(),
        paragraphs: c.paragraphs.iter().map(flat_paragraph).collect(),
    }
}
