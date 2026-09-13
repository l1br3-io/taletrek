//! The interchange hop: [`ParsedBook`] → text-only [`BookBundle`].
//!
//! This module is the one place the parse core touches randomness and the
//! clock: bundle ids (`bk_<uuid-v4>`) and timestamps (now-ms) are born here,
//! at bundle-build time — never during parsing. The output is a v1
//! text-only `.taletrek` bundle (`audio.present == false`, empty audio map):
//! the same shape `synth` accepts as input, so parse → synth chains without
//! translation.
//!
//! Purity note: no file I/O. The bundle is returned in memory; writing it to
//! disk stays host-side (the desktop CLI's `write_book_bundle_file`).

use taletrek_synth::bundle::manifest::{AudioMeta, Generator, Manifest, ManifestKind};
use taletrek_synth::bundle::text::ChapterText;
use taletrek_synth::{AudioCodec, BookBundle, BookMeta, NORM_VERSION, SCHEMA_VERSION};

use crate::{ParsedBook, SourceFormat};

/// Wrap a parsed book into a v1 text-only [`BookBundle`].
///
/// - Book id: fresh `bk_<uuid-v4>` (a new id per call — the caller gets a
///   distinct bundle for a distinct build, never a shared identity).
/// - Chapter ids: `ch_{book_id}_{index}` for each chapter in reading order.
/// - Timestamps: `createdAt` and `updatedAt` are both now-ms.
/// - Audio: absent (`present: false`, empty map) — this is pre-synth output.
/// - `generator` is a **parameter** (mirroring `taletrek-worker`'s
///   parameterized-app stamping seam): the desktop CLI, the GUI, and the
///   mobile apps stamp their own producer identity through one path, and no
///   host-specific string lives in this crate.
#[must_use]
pub fn to_text_only_bundle(book: &ParsedBook, voice_id: &str, generator: Generator) -> BookBundle {
    let book_id = format!("bk_{}", uuid::Uuid::new_v4());
    to_text_only_bundle_with_id(book, voice_id, generator, &book_id)
}

/// [`to_text_only_bundle`] with a caller-supplied book id — the seam the
/// pipeline uses to pin a **deterministic content-derived id** (see
/// [`deterministic_book_id`]) before chapter stamping: chapter ids
/// `ch_{book_id}_{idx}` derive from it, so the id must be fixed here, at
/// bundle-build time, not patched into the manifest afterwards.
#[must_use]
pub fn to_text_only_bundle_with_id(
    book: &ParsedBook,
    voice_id: &str,
    generator: Generator,
    book_id: &str,
) -> BookBundle {
    let now = now_ms();
    let chapter_count = u32::try_from(book.chapters.len()).unwrap_or(u32::MAX);
    let chapters = book
        .chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| {
            // ChapterText::new stamps the ch_{book_id}_{index} id and leaves
            // headings empty — exactly this module's contract.
            ChapterText::new(
                book_id,
                u32::try_from(index).unwrap_or(u32::MAX),
                &chapter.title,
                chapter.paragraphs.clone(),
            )
        })
        .collect();

    BookBundle {
        manifest: Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: book_id.to_string(),
                title: book.title.clone(),
                author: book.author.clone(),
                source_format: source_format_string(book.source_format).to_string(),
                chapter_count,
                voice_id: voice_id.to_string(),
                created_at: now,
                updated_at: now,
                progress_fraction: None,
            },
            // Dormant descriptor: the codec is a placeholder that read paths
            // ignore while `present == false`; it flips to the encoder's real
            // codec when synth stamps the bundle full.
            audio: AudioMeta {
                present: false,
                codec: AudioCodec::Opus,
                norm_version: NORM_VERSION
                    .parse()
                    .expect("NORM_VERSION is a decimal u32 (synth crate invariant)"),
                segment_count: 0,
            },
            generator,
        },
        chapters,
        audio: std::collections::HashMap::new(),
    }
}

/// Derive a **deterministic** book id from parsed content: `bk_<16 hex>`
/// (first 16 hex chars of SHA-256).
///
/// Why deterministic: the pipeline's re-import policy is "same document ⇒
/// same book id ⇒ `books/<id>.taletrek` overwrite, no duplicates" — a fresh
/// UUID per call ([`to_text_only_bundle`]) would make every re-import a new
/// book. Ids also feed the library scan, so stability across runs is what
/// keeps positions and shelves coherent.
///
/// Hash domain (versioned so a future domain change mints new ids instead of
/// silently colliding with v1): the tag `taletrek-book-id/1`, then title,
/// author, chapter count, and every chapter's title + paragraphs, each field
/// NUL-separated — separators prevent concatenation ambiguity (title "ab" +
/// author "c" hashes differently than title "a" + author "bc").
///
/// Not included: `source_format` (the same text parsed from a re-exported
/// EPUB→TXT stays the same book), timestamps, and the generator identity.
#[must_use]
pub fn deterministic_book_id(book: &ParsedBook) -> String {
    use sha2::{Digest, Sha256};

    fn feed(hasher: &mut Sha256, field: &str) {
        hasher.update(field.as_bytes());
        hasher.update([0]);
    }

    let mut hasher = Sha256::new();
    hasher.update(b"taletrek-book-id/1");
    hasher.update([0]);
    feed(&mut hasher, &book.title);
    feed(&mut hasher, book.author.as_deref().unwrap_or(""));
    hasher.update(book.chapters.len().to_le_bytes());
    for chapter in &book.chapters {
        feed(&mut hasher, &chapter.title);
        for paragraph in &chapter.paragraphs {
            feed(&mut hasher, paragraph);
        }
    }
    let digest = hasher.finalize();
    format!("bk_{}", hex::encode(&digest[..8]))
}

/// Now-ms since the Unix epoch — the one clock read in the parse core.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis() as u64
}

/// The manifest `sourceFormat` vocabulary: one lowercase string per
/// [`SourceFormat`]. Never `unknown` — a parsed book always knows its
/// format. (MOBI is absent by scope; the SPA's `unknown` is an import-time
/// fallback that never applies here.)
fn source_format_string(format: SourceFormat) -> &'static str {
    match format {
        SourceFormat::Epub => "epub",
        SourceFormat::Txt => "txt",
        SourceFormat::Html => "html",
        SourceFormat::Md => "md",
        SourceFormat::Docx => "docx",
        SourceFormat::Pdf => "pdf",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    use taletrek_synth::{read_book_bundle, write_book_bundle};

    use crate::{ParsedBook, ParsedChapter};

    #[test]
    fn deterministic_book_id_separator_sensitivity() {
        let a = ParsedBook {
            title: "ab".into(),
            author: Some("c".into()),
            source_format: SourceFormat::Txt,
            chapters: vec![ParsedChapter {
                title: "one".into(),
                paragraphs: vec!["p".into()],
            }],
        };
        let b = ParsedBook {
            title: "a".into(),
            author: Some("bc".into()),
            source_format: SourceFormat::Md,
            chapters: vec![ParsedChapter {
                title: "one".into(),
                paragraphs: vec!["p".into()],
            }],
        };
        assert_ne!(
            deterministic_book_id(&a),
            deterministic_book_id(&b),
            "field boundaries must hash differently"
        );
        assert_eq!(
            deterministic_book_id(&a),
            deterministic_book_id(&a),
            "same content ⇒ same id"
        );
        assert!(deterministic_book_id(&a).starts_with("bk_"));
        assert_eq!(deterministic_book_id(&a).len(), 3 + 16);
    }

    #[test]
    fn with_id_variant_stamps_the_given_id_into_chapters() {
        let book = ParsedBook {
            title: "T".into(),
            author: None,
            source_format: SourceFormat::Txt,
            chapters: vec![ParsedChapter {
                title: "c".into(),
                paragraphs: vec!["p".into()],
            }],
        };
        let bundle = to_text_only_bundle_with_id(
            &book,
            "v",
            Generator {
                app: "test".into(),
                version: "0".into(),
            },
            "bk_fixed",
        );
        assert_eq!(bundle.manifest.book.id, "bk_fixed");
        assert_eq!(bundle.chapters[0].id, "ch_bk_fixed_0");
    }

    const TEST_VOICE: &str = "en_US-ryan-medium";

    /// The generator a host would pass — deliberately NOT a real TaleTrek app
    /// id, pinning that the crate stamps exactly what it is given.
    fn test_generator() -> Generator {
        Generator {
            app: "taletrek-test-host".into(),
            version: "9.9.9".into(),
        }
    }

    fn parsed_book() -> ParsedBook {
        ParsedBook {
            title: "The Trek".into(),
            author: Some("A. Uthor".into()),
            source_format: SourceFormat::Txt,
            chapters: vec![
                ParsedChapter {
                    title: "Departure".into(),
                    paragraphs: vec!["We walked out the door.".into(), "Then kept going.".into()],
                },
                ParsedChapter {
                    title: "Return".into(),
                    paragraphs: vec!["Home again.".into()],
                },
            ],
        }
    }

    #[test]
    fn round_trip_manifest_and_chapters_are_correct() {
        let book = parsed_book();
        let before_ms = now_ms();
        let bundle = to_text_only_bundle(&book, TEST_VOICE, test_generator());
        let after_ms = now_ms();

        let m = &bundle.manifest;
        assert_eq!(m.schema_version, SCHEMA_VERSION);
        assert_eq!(
            m.schema_version, 1,
            "SCHEMA_VERSION must stay untouched at 1"
        );
        assert!(matches!(m.kind, ManifestKind::Book));
        let book_id = m.book.id.clone();
        assert!(book_id.starts_with("bk_"), "book id {book_id}");
        let uuid_part = book_id.strip_prefix("bk_").expect("bk_ prefix");
        let uuid = uuid::Uuid::parse_str(uuid_part).expect("id carries a valid uuid");
        assert_eq!(uuid.get_version_num(), 4, "book id must be a uuid v4");

        assert_eq!(m.book.title, "The Trek");
        assert_eq!(m.book.author.as_deref(), Some("A. Uthor"));
        assert_eq!(m.book.source_format, "txt");
        assert_eq!(m.book.chapter_count, 2);
        assert_eq!(m.book.voice_id, TEST_VOICE);
        assert_eq!(m.book.progress_fraction, None);
        assert!(
            m.book.created_at >= before_ms && m.book.created_at <= after_ms,
            "createdAt {} must be the build-time now-ms",
            m.book.created_at
        );
        assert_eq!(m.book.created_at, m.book.updated_at);

        assert!(
            !m.audio.present,
            "text-only bundle must declare audio absent"
        );
        assert_eq!(m.audio.segment_count, 0);
        assert!(
            bundle.audio.is_empty(),
            "text-only bundle carries no segments"
        );
        assert_eq!(m.generator.app, "taletrek-test-host");
        assert_eq!(m.generator.version, "9.9.9");

        // Chapter ids follow ch_{book_id}_{index}; text maps 1:1; headings empty.
        for (index, (chapter, parsed)) in bundle.chapters.iter().zip(&book.chapters).enumerate() {
            assert_eq!(chapter.id, format!("ch_{book_id}_{index}"));
            assert_eq!(chapter.book_id, book_id);
            assert_eq!(u32::try_from(index).unwrap(), chapter.index);
            assert_eq!(chapter.title, parsed.title);
            assert_eq!(chapter.paragraphs, parsed.paragraphs);
            assert!(chapter.headings.is_empty(), "headings stay empty");
        }

        // Round-trip: write → read → everything survives serialization.
        let mut buf = Cursor::new(Vec::new());
        write_book_bundle(&bundle, &mut buf).expect("write");
        let back = read_book_bundle(&buf.into_inner()).expect("read");

        let mb = &back.manifest;
        assert_eq!(mb.schema_version, m.schema_version);
        assert!(matches!(mb.kind, ManifestKind::Book));
        assert_eq!(mb.book.id, book_id);
        assert_eq!(mb.book.title, m.book.title);
        assert_eq!(mb.book.author, m.book.author);
        assert_eq!(mb.book.source_format, m.book.source_format);
        assert_eq!(mb.book.chapter_count, m.book.chapter_count);
        assert_eq!(mb.book.voice_id, m.book.voice_id);
        assert_eq!(mb.book.created_at, m.book.created_at);
        assert_eq!(mb.book.updated_at, m.book.updated_at);
        assert!(!mb.audio.present);
        assert_eq!(mb.audio.segment_count, 0);
        assert_eq!(mb.generator.app, "taletrek-test-host");
        assert_eq!(mb.generator.version, "9.9.9");
        assert!(back.audio.is_empty());

        assert_eq!(back.chapters.len(), 2);
        for (index, (chapter, parsed)) in back.chapters.iter().zip(&book.chapters).enumerate() {
            assert_eq!(chapter.id, format!("ch_{book_id}_{index}"));
            assert_eq!(chapter.book_id, book_id);
            assert_eq!(chapter.title, parsed.title);
            assert_eq!(chapter.paragraphs, parsed.paragraphs);
            assert!(chapter.headings.is_empty());
        }
    }

    #[test]
    fn every_source_format_maps_to_its_manifest_vocabulary() {
        for (format, expected) in [
            (SourceFormat::Epub, "epub"),
            (SourceFormat::Txt, "txt"),
            (SourceFormat::Html, "html"),
            (SourceFormat::Md, "md"),
            (SourceFormat::Docx, "docx"),
            (SourceFormat::Pdf, "pdf"),
        ] {
            let book = ParsedBook {
                title: "T".into(),
                author: None,
                source_format: format,
                chapters: vec![ParsedChapter {
                    title: "C".into(),
                    paragraphs: vec!["p".into()],
                }],
            };
            let bundle = to_text_only_bundle(&book, TEST_VOICE, test_generator());
            assert_eq!(
                bundle.manifest.book.source_format, expected,
                "manifest vocabulary for {format:?}"
            );
        }
    }

    #[test]
    fn each_call_stamps_a_fresh_book_id() {
        let book = parsed_book();
        let a = to_text_only_bundle(&book, TEST_VOICE, test_generator());
        let b = to_text_only_bundle(&book, TEST_VOICE, test_generator());
        assert_ne!(
            a.manifest.book.id, b.manifest.book.id,
            "book ids must be per-call uuid v4s"
        );
        // Chapter ids follow their own bundle's book id — no cross-wiring.
        assert_eq!(b.chapters[0].book_id, b.manifest.book.id,);
    }

    #[test]
    fn authorless_book_round_trips_with_absent_author() {
        let mut book = parsed_book();
        book.author = None;
        let bundle = to_text_only_bundle(&book, TEST_VOICE, test_generator());
        assert_eq!(bundle.manifest.book.author, None);

        let mut buf = Cursor::new(Vec::new());
        write_book_bundle(&bundle, &mut buf).expect("write");
        let back = read_book_bundle(&buf.into_inner()).expect("read");
        assert_eq!(back.manifest.book.author, None);
    }

    #[test]
    fn norm_version_is_the_current_cache_key_version() {
        let bundle = to_text_only_bundle(&parsed_book(), TEST_VOICE, test_generator());
        let expected: u32 = NORM_VERSION.parse().expect("NORM_VERSION is decimal u32");
        assert_eq!(bundle.manifest.audio.norm_version, expected);
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_millis() as u64
    }
}
