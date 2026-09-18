//! Book opening over the FFI surface — bundle path in, flattened records
//! out. Audio is never touched on open (G27's lesson applies to phone RAM
//! budgets more than anywhere): segments stream per paragraph via
//! [`read_segment`].

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use taletrek_reader::{BookIndex, ChapterIndex, ParagraphIndex};
use taletrek_synth::{read_audio_segment, read_book_metadata};

use crate::error::FfiError;

/// The process-global segment store root — where [`read_segment_progressive`]
/// serves landed segments for filling (text-only) bundles. The host app
/// registers the store its pipeline jobs synth into (one store is the
/// design: content-addressed, shared across books); `None` until then.
static SEGMENT_STORE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Register (or clear) the segment store the progressive read seam serves
/// filling books from. Call with the same directory the pipeline's
/// progressive config carries; `None` unregisters.
#[uniffi::export]
pub fn set_segment_store(dir: Option<String>) {
    *SEGMENT_STORE.lock().expect("segment store mutex") = dir.map(PathBuf::from);
}

/// Whether a segment store is registered — the host's statement that
/// filling-book playback is available (the player honors it).
pub(crate) fn segment_store_registered() -> bool {
    SEGMENT_STORE.lock().expect("segment store mutex").is_some()
}

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
    /// Author, when the manifest knows one (library search matches on it).
    pub author: Option<String>,
    /// The voice the manifest advertises (`book.voiceId`) — what a later
    /// re-voice would replace; the pipeline's import flow surfaces it.
    pub voice_id: String,
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
    let mut book: FfiBook = BookIndex::new(&manifest, &chapters).into();
    book.author = manifest.book.author;
    book.voice_id = manifest.book.voice_id;
    Ok(book)
}

/// Read one audio segment's bytes from the bundle at `path` — the
/// single-entry disk read, verbatim. `None` when the archive carries no
/// segment for `key` (including every key on a text-only bundle).
#[uniffi::export]
pub fn read_segment(path: String, key: String) -> Result<Option<Vec<u8>>, FfiError> {
    Ok(read_audio_segment(Path::new(&path), &key)?.map(|seg| seg.bytes))
}

/// The typed answer to "can I play paragraph `key` right now?" — the
/// progressive reader's read seam. [`FfiSegmentStatus::Ready`] carries the
/// segment; [`FfiSegmentStatus::NotReady`] means the key is *expected* (the
/// book is filling: a text-only bundle whose chapters reference the key —
/// the job is alive or resumable); [`FfiSegmentStatus::Missing`] means the
/// bundle is sealed/full and the key is genuinely absent (corrupt archive
/// or a foreign key — never a wait-worthy state).
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum FfiSegmentStatus {
    /// The segment's bytes + codec extension (`opus`/`wav`/`m4a`).
    Ready {
        /// Encoded audio bytes, verbatim.
        bytes: Vec<u8>,
        /// Codec extension (`opus`/`wav`/`m4a`) — what `decode_segment`
        /// expects alongside the bytes.
        codec: String,
    },
    /// Expected but not synthesized yet — the book is filling; the caller
    /// may block briefly (buffering UX) or surface resume.
    NotReady,
    /// The sealed bundle has no such segment — not coming.
    Missing,
}

/// The progressive read seam: [`read_segment`] split by *why* it's absent.
/// See [`FfiSegmentStatus`] for the semantics.
#[uniffi::export]
pub fn read_segment_progressive(path: String, key: String) -> Result<FfiSegmentStatus, FfiError> {
    let path = Path::new(&path);
    let (manifest, chapters) = read_book_metadata(path)?;
    if manifest.audio.present {
        return Ok(match read_audio_segment(path, &key)? {
            Some(seg) => FfiSegmentStatus::Ready {
                bytes: seg.bytes,
                codec: seg.codec.ext().to_string(),
            },
            None => FfiSegmentStatus::Missing,
        });
    }
    // Text-only (filling): the key is NotReady exactly when the book's own
    // chapters reference it — the manifest voice namespaces the key. A
    // landed store segment upgrades the answer to Ready: the reader plays
    // while the book fills.
    let expected = chapters.iter().any(|ch| {
        ch.paragraphs
            .iter()
            .any(|p| taletrek_synth::cache_key(&manifest.book.voice_id, p) == key)
    });
    Ok(if expected {
        let store_dir = SEGMENT_STORE.lock().expect("segment store mutex").clone();
        store_dir
            .and_then(|dir| {
                taletrek_worker::SegmentStore::open(&dir)
                    .ok()
                    .and_then(|store| store.get(&key).ok().flatten())
            })
            .map(|seg| FfiSegmentStatus::Ready {
                bytes: seg.bytes,
                codec: seg.codec.ext().to_string(),
            })
            .unwrap_or(FfiSegmentStatus::NotReady)
    } else {
        FfiSegmentStatus::Missing
    })
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
            // Filled by `open_book` from the manifest — `BookIndex` (the
            // reader core) doesn't carry voice or author identity.
            author: None,
            voice_id: String::new(),
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
