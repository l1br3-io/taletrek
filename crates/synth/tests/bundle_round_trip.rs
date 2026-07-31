//! Bundle round-trip conformance: write a bundle to bytes, read it back, assert
//! the in-memory model is preserved. Covers text-only, full, and library.

use std::collections::HashMap;
use std::io::Cursor;

use taletrek_synth::{
    cache_key, normalize_for_speech, read_book_bundle, read_library_bundle, write_book_bundle,
    write_library_bundle, AudioCodec, AudioMeta, AudioSegment, BookBundle, BookMeta, BundleError,
    ChapterText, Generator, LibraryBundle, LibraryEntry, LibraryKind, LibraryManifest, Manifest,
    ManifestKind, NORM_VERSION, SCHEMA_VERSION,
};

fn sample_manifest(present: bool, segment_count: u32) -> Manifest {
    Manifest {
        schema_version: SCHEMA_VERSION,
        kind: ManifestKind::Book,
        book: BookMeta {
            id: "bk_01EXAMPLE".to_string(),
            title: "Sample Book".to_string(),
            author: Some("A. Author".to_string()),
            source_format: "epub".to_string(),
            chapter_count: 1,
            voice_id: "en_US-lessac-medium".to_string(),
            created_at: 1_780_000_000_000,
            updated_at: 1_780_000_000_000,
            progress_fraction: Some(0.0),
        },
        audio: AudioMeta {
            present,
            codec: AudioCodec::Opus,
            norm_version: NORM_VERSION.parse().unwrap(),
            segment_count,
        },
        generator: Generator {
            app: "taletrek-synth-test".to_string(),
            version: "0.1.0".to_string(),
        },
    }
}

fn sample_chapters() -> Vec<ChapterText> {
    vec![ChapterText::new(
        "bk_01EXAMPLE",
        0,
        "Chapter One",
        vec![
            "Hello world.".to_string(),
            "O\u{2019}Reilly books.".to_string(),
        ],
    )]
}

#[test]
fn text_only_bundle_round_trips() {
    let bundle = BookBundle {
        manifest: sample_manifest(false, 0),
        chapters: sample_chapters(),
        audio: HashMap::new(),
    };
    let mut buf = Cursor::new(Vec::new());
    write_book_bundle(&bundle, &mut buf).unwrap();
    let bytes = buf.into_inner();

    let back = read_book_bundle(&bytes).unwrap();
    assert_eq!(back.manifest.book.id, "bk_01EXAMPLE");
    assert!(!back.manifest.audio.present);
    assert_eq!(back.chapters.len(), 1);
    assert_eq!(back.chapters[0].paragraphs.len(), 2);
    assert!(back.audio.is_empty());
}

#[test]
fn full_bundle_round_trips_with_audio() {
    // The audio key is a real cache key for a paragraph, so the naming matches
    // what the synth pipeline would actually emit.
    let voice = "en_US-lessac-medium";
    let para = "Hello world.";
    let key = cache_key(voice, para);

    let mut audio = HashMap::new();
    audio.insert(
        key.clone(),
        AudioSegment {
            key: key.clone(),
            codec: AudioCodec::Opus,
            bytes: vec![0x4F, 0x70, 0x75, 0x73],
        },
    );

    let bundle = BookBundle {
        manifest: sample_manifest(true, 1),
        chapters: sample_chapters(),
        audio,
    };
    let mut buf = Cursor::new(Vec::new());
    write_book_bundle(&bundle, &mut buf).unwrap();
    let bytes = buf.into_inner();

    let back = read_book_bundle(&bytes).unwrap();
    assert!(back.manifest.audio.present);
    assert_eq!(back.manifest.audio.segment_count, 1);
    assert_eq!(back.audio.len(), 1);
    let seg = back.audio.get(&key).expect("segment present");
    assert_eq!(seg.codec, AudioCodec::Opus);
    assert_eq!(seg.bytes, vec![0x4F, 0x70, 0x75, 0x73]);
}

#[test]
fn unknown_schema_version_is_refused() {
    let mut bundle = BookBundle {
        manifest: sample_manifest(false, 0),
        chapters: sample_chapters(),
        audio: HashMap::new(),
    };
    bundle.manifest.schema_version = 999;
    let mut buf = Cursor::new(Vec::new());
    write_book_bundle(&bundle, &mut buf).unwrap();

    let err = read_book_bundle(&buf.into_inner()).unwrap_err();
    match err {
        BundleError::UnknownSchema { found, supported } => {
            assert_eq!(found, 999);
            assert_eq!(supported, SCHEMA_VERSION);
        }
        other => panic!("expected UnknownSchema, got {other:?}"),
    }
}

#[test]
fn library_bundle_round_trips() {
    let book = BookBundle {
        manifest: sample_manifest(false, 0),
        chapters: sample_chapters(),
        audio: HashMap::new(),
    };
    let book_id = book.manifest.book.id.clone();
    let book_title = book.manifest.book.title.clone();

    let lib = LibraryBundle {
        manifest: LibraryManifest {
            schema_version: SCHEMA_VERSION,
            kind: LibraryKind::Library,
            exported_at: 1_780_000_000_000,
            book_count: 1,
            books: vec![LibraryEntry {
                id: book_id.clone(),
                title: book_title,
                file: format!("books/{book_id}.taletrek"),
            }],
            generator: Generator {
                app: "taletrek-synth-test".to_string(),
                version: "0.1.0".to_string(),
            },
        },
        books: vec![book],
    };
    let _ = normalize_for_speech("noop"); // touch import to avoid dead-code warnings if unused
    let _ = NORM_VERSION;

    let mut buf = Cursor::new(Vec::new());
    write_library_bundle(&lib, &mut buf).unwrap();
    let back = read_library_bundle(&buf.into_inner()).unwrap();
    assert_eq!(back.books.len(), 1);
    assert_eq!(back.books[0].manifest.book.id, "bk_01EXAMPLE");
}
