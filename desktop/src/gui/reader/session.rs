//! The reader's pure open flow (task 004): path → bundle metadata → session.
//!
//! UI-free by construction (no egui import) so the open path is
//! headless-testable: [`open`] reads the bundle's manifest + chapter text
//! via [`taletrek_synth::read_book_metadata`] (never audio — G27) and folds
//! them into a [`taletrek_reader::BookIndex`], keeping only the display
//! line the header renders. Every typed [`taletrek_synth::BundleError`]
//! maps to one human sentence (the T9 [`crate::gui::executor`]
//! `humanize_error` pattern) — the reader never surfaces a raw error
//! chain, and it never panics on a bad bundle.

use std::path::{Path, PathBuf};

use taletrek_reader::BookIndex;
use taletrek_synth::{BundleError, Manifest};

/// An opened reader session: everything the reader screen renders, frozen
/// at open time. The book itself lives in the kernel's [`BookIndex`];
/// `path` stays for position keying (task 007) and `meta` is the
/// pre-joined header line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReaderSession {
    /// The bundle this session was opened from.
    pub(crate) path: PathBuf,
    /// The navigable book (kernel core).
    pub(crate) book: BookIndex,
    /// The header's meta line (`author · N chapters · voice · narrated`).
    pub(crate) meta: String,
}

/// Why an open failed — one human sentence, ready to render. The sentence
/// is the whole payload: the caller adds the file context around it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub(crate) struct OpenError(String);

impl OpenError {
    /// The human sentence for this failure.
    pub(crate) fn sentence(&self) -> &str {
        &self.0
    }
}

/// Open `path` as a reader session: manifest + text read (audio never
/// touched), [`BookIndex`] built, meta line joined. Total — every failure
/// is a typed [`BundleError`] mapped to an [`OpenError`] sentence.
pub(crate) fn open(path: &Path) -> Result<ReaderSession, OpenError> {
    let (manifest, chapters) =
        taletrek_synth::read_book_metadata(path).map_err(humanize_bundle_error)?;
    let book = BookIndex::new(&manifest, &chapters);
    let meta = meta_line(&manifest, &book);
    Ok(ReaderSession {
        path: path.to_owned(),
        book,
        meta,
    })
}

/// The header's one-line summary of the book. Chapter count comes from
/// the built index (what the reader actually renders, not the manifest's
/// claim); the trailing marker names the audio state in reader terms.
pub(crate) fn meta_line(manifest: &Manifest, book: &BookIndex) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(author) = manifest
        .book
        .author
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        parts.push(author.to_owned());
    }
    let count = book.chapters.len();
    parts.push(format!(
        "{count} chapter{}",
        if count == 1 { "" } else { "s" }
    ));
    parts.push(manifest.book.voice_id.clone());
    parts.push(if book.audio_present {
        "narrated".to_owned()
    } else {
        "text only".to_owned()
    });
    parts.join(" · ")
}

/// One typed bundle failure → one human sentence (the T9 pattern; mirrors
/// the queue's `humanize_error` where the sentences overlap).
fn humanize_bundle_error(err: BundleError) -> OpenError {
    let sentence = match &err {
        BundleError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => {
            "the file is missing — it may have been moved, renamed, or deleted.".to_owned()
        }
        BundleError::Io(_) => "the file could not be read.".to_owned(),
        BundleError::UnknownSchema { found, supported } => format!(
            "this bundle was written by a newer TaleTrek (schema v{found}, this app reads \
             v{supported}) — update TaleTrek."
        ),
        BundleError::MissingEntry(entry) => {
            format!("this file is not a TaleTrek bundle — {entry} is missing.")
        }
        BundleError::Zip(_) => "this file is corrupt or not a TaleTrek bundle.".to_owned(),
        BundleError::Json(_) => "the bundle's contents are corrupt.".to_owned(),
        BundleError::EntryTooLarge { .. } | BundleError::TotalTooLarge { .. } => {
            "this bundle is unexpectedly large — it may be corrupt.".to_owned()
        }
        BundleError::InvalidAudioKey(_) => {
            // The open flow reads no audio, so no key is ever validated —
            // unreachable by construction; keep a sentence anyway (total).
            "the bundle names an invalid audio entry.".to_owned()
        }
    };
    OpenError(sentence)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
    use taletrek_synth::{
        write_book_bundle, AudioCodec, BookBundle, ChapterText, NORM_VERSION, SCHEMA_VERSION,
    };

    const VOICE: &str = "en_US-amy-medium";

    /// A manifest fixture with the given audio presence and optional author.
    fn manifest(audio: bool, author: Option<&str>) -> Manifest {
        Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_test".into(),
                title: "A Small Adventure".into(),
                author: author.map(str::to_owned),
                source_format: "epub".into(),
                chapter_count: 2,
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

    fn chapters() -> Vec<ChapterText> {
        vec![
            ChapterText::new("bk_test", 0, "The Beginning", vec!["Once past.".into()]),
            ChapterText::new(
                "bk_test",
                1,
                "The End",
                vec!["Penultimate.".into(), "Finally.".into()],
            ),
        ]
    }

    /// Write a fixture bundle to a temp file; returns (kept-alive dir, path).
    fn bundle_on_disk(bundle: BookBundle) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.taletrek");
        let mut buf = std::io::Cursor::new(Vec::new());
        write_book_bundle(&bundle, &mut buf).unwrap();
        std::fs::write(&path, buf.into_inner()).unwrap();
        (dir, path)
    }

    fn bundle(audio: bool, author: Option<&str>) -> BookBundle {
        BookBundle {
            manifest: manifest(audio, author),
            chapters: chapters(),
            audio: HashMap::new(),
        }
    }

    #[test]
    fn open_builds_a_session_from_an_audio_bundle() {
        let (_dir, path) = bundle_on_disk(bundle(true, Some("Ursula Vernon")));
        let session = open(&path).expect("audio bundle opens");

        assert_eq!(session.path, path);
        assert_eq!(session.book.title, "A Small Adventure");
        assert!(session.book.audio_present);
        assert_eq!(session.book.chapters.len(), 2);
        assert_eq!(session.book.chapters[0].title, "The Beginning");
        assert_eq!(
            session.meta,
            "Ursula Vernon · 2 chapters · en_US-amy-medium · narrated"
        );
    }

    #[test]
    fn open_builds_a_session_from_a_text_only_bundle() {
        let (_dir, path) = bundle_on_disk(bundle(false, None));
        let session = open(&path).expect("text-only bundle opens");

        assert!(!session.book.audio_present);
        // No author part; the trailing marker names the text-only state.
        assert_eq!(session.meta, "2 chapters · en_US-amy-medium · text only");
    }

    #[test]
    fn open_surfaces_a_missing_file_as_a_human_sentence() {
        let err = open(Path::new("/nonexistent-taletrek-test/book.taletrek")).unwrap_err();
        let sentence = err.sentence();
        assert!(
            sentence.to_lowercase().contains("missing"),
            "mentions missing: {sentence}"
        );
        assert!(
            sentence.to_lowercase().contains("moved")
                || sentence.to_lowercase().contains("deleted"),
            "actionable: {sentence}"
        );
    }

    #[test]
    fn open_surfaces_a_corrupt_archive_as_a_human_sentence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("garbage.taletrek");
        std::fs::write(&path, b"definitely not a zip archive").unwrap();

        let err = open(&path).unwrap_err();
        let sentence = err.sentence();
        assert!(
            sentence.to_lowercase().contains("corrupt"),
            "mentions corrupt: {sentence}"
        );
    }

    #[test]
    fn open_surfaces_a_schema_mismatch_as_an_upgrade_sentence() {
        let mut b = bundle(false, None);
        b.manifest.schema_version = SCHEMA_VERSION + 1;
        let (_dir, path) = bundle_on_disk(b);

        let err = open(&path).unwrap_err();
        let sentence = err.sentence();
        assert!(
            sentence.to_lowercase().contains("newer"),
            "names the cause: {sentence}"
        );
        assert!(
            sentence.to_lowercase().contains("update"),
            "actionable: {sentence}"
        );
    }

    #[test]
    fn meta_line_pluralizes_one_chapter_and_skips_blank_authors() {
        let one = BookIndex::new(&manifest(false, None), &chapters()[..1]);
        assert_eq!(
            meta_line(&manifest(false, None), &one),
            format!("1 chapter · {VOICE} · text only")
        );

        let blank = manifest(false, Some("   "));
        assert!(
            !meta_line(&blank, &one).starts_with("   "),
            "blank author contributes no part"
        );
    }
}
