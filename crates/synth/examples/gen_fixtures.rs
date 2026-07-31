//! Generate the canonical conformance fixtures under `tests/fixtures/`.
//!
//! Run with: `cargo run -p taletrek-synth --example gen_fixtures`.
//!
//! The three archives produced here are the cross-language contract: the TS
//! bundle implementation (effort 3) MUST read them unchanged. Never hand-edit;
//! always regenerate via this binary.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use taletrek_synth::{
    cache_key, write_book_bundle, write_library_bundle, AudioCodec, AudioMeta, AudioSegment,
    BookBundle, BookMeta, ChapterText, Generator, LibraryBundle, LibraryEntry, LibraryKind,
    LibraryManifest, Manifest, ManifestKind, NORM_VERSION, SCHEMA_VERSION,
};

fn main() -> std::io::Result<()> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    fs::create_dir_all(&dir)?;

    let voice = "en_US-lessac-medium";
    let chapters = vec![
        ChapterText::new(
            "bk_sample",
            0,
            "Chapter One",
            vec![
                "Hello world.".to_string(),
                "The quick brown fox jumps over the lazy dog.".to_string(),
            ],
        ),
        ChapterText::new(
            "bk_sample",
            1,
            "Chapter Two",
            vec!["O\u{2019}Reilly books are well worth reading.".to_string()],
        ),
    ];

    let generator = Generator {
        app: "taletrek-synth".to_string(),
        version: "0.1.0".to_string(),
    };

    // 1. Text-only bundle (pre-synth).
    let text_only = BookBundle {
        manifest: Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_sample".to_string(),
                title: "Sample Book".to_string(),
                author: Some("Fixture Generator".to_string()),
                source_format: "epub".to_string(),
                chapter_count: 2,
                voice_id: voice.to_string(),
                created_at: 1_780_000_000_000,
                updated_at: 1_780_000_000_000,
                progress_fraction: None,
            },
            audio: AudioMeta {
                present: false,
                codec: AudioCodec::Opus,
                norm_version: NORM_VERSION.parse().unwrap(),
                segment_count: 0,
            },
            generator: generator.clone(),
        },
        chapters: chapters.clone(),
        audio: HashMap::new(),
    };
    write_bundle(&text_only, dir.join("book-text-only.taletrek"))?;

    // 2. Full bundle (with synthetic Opus audio for each paragraph).
    let mut audio = HashMap::new();
    for para in [
        "Hello world.",
        "The quick brown fox jumps over the lazy dog.",
        "O\u{2019}Reilly books are well worth reading.",
    ] {
        let key = cache_key(voice, para);
        audio.insert(
            key.clone(),
            AudioSegment {
                key,
                codec: AudioCodec::Opus,
                // Synthetic, non-playable bytes — conformance is structural, not audio.
                bytes: b"OG OpusHead fixture-synthetic".to_vec(),
            },
        );
    }
    let mut full = text_only.clone();
    full.manifest.audio.present = true;
    full.manifest.audio.segment_count = audio.len() as u32;
    full.audio = audio;
    write_bundle(&full, dir.join("book-full.taletrek"))?;

    // 3. Library bundle wrapping the text-only book.
    let lib = LibraryBundle {
        manifest: LibraryManifest {
            schema_version: SCHEMA_VERSION,
            kind: LibraryKind::Library,
            exported_at: 1_780_000_000_000,
            book_count: 1,
            books: vec![LibraryEntry {
                id: "bk_sample".to_string(),
                title: "Sample Book".to_string(),
                file: "books/bk_sample.taletrek".to_string(),
            }],
            generator,
        },
        books: vec![text_only],
    };
    let mut buf = Cursor::new(Vec::new());
    write_library_bundle(&lib, &mut buf).expect("write library bundle");
    fs::write(dir.join("library.taletrek-lib"), buf.into_inner())?;

    println!("fixtures written to {}", dir.display());
    Ok(())
}

fn write_bundle(bundle: &BookBundle, path: PathBuf) -> std::io::Result<()> {
    let mut buf = Cursor::new(Vec::new());
    write_book_bundle(bundle, &mut buf).expect("write book bundle");
    fs::write(path, buf.into_inner())
}
