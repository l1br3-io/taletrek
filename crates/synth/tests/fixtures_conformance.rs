//! Conformance: the committed fixtures under `tests/fixtures/` load cleanly and
//! their manifest fields match what the generator wrote. These archives are the
//! cross-language contract — the TS implementation (effort 3) must read them
//! unchanged.

use std::fs;
use std::io::Cursor;

use taletrek_synth::{read_book_bundle, read_library_bundle};

const FIXTURE_DIR: &str = "tests/fixtures";

#[test]
fn text_only_fixture_loads() {
    let bytes = fs::read(format!("{FIXTURE_DIR}/book-text-only.taletrek")).unwrap();
    let bundle = read_book_bundle(&bytes).unwrap();
    assert_eq!(bundle.manifest.book.id, "bk_sample");
    assert_eq!(bundle.manifest.book.title, "Sample Book");
    assert!(!bundle.manifest.audio.present);
    assert_eq!(bundle.chapters.len(), 2);
    assert_eq!(bundle.chapters[0].title, "Chapter One");
    assert!(bundle.audio.is_empty());
}

#[test]
fn full_fixture_loads_with_audio() {
    let bytes = fs::read(format!("{FIXTURE_DIR}/book-full.taletrek")).unwrap();
    let bundle = read_book_bundle(&bytes).unwrap();
    assert!(bundle.manifest.audio.present);
    assert_eq!(
        bundle.manifest.audio.codec,
        taletrek_synth::AudioCodec::Opus
    );
    assert_eq!(
        bundle.manifest.audio.segment_count as usize,
        bundle.audio.len()
    );
    // Three paragraphs across the two chapters.
    assert_eq!(bundle.audio.len(), 3);
}

#[test]
fn library_fixture_loads() {
    let bytes = fs::read(format!("{FIXTURE_DIR}/library.taletrek-lib")).unwrap();
    let lib = read_library_bundle(&bytes).unwrap();
    assert_eq!(lib.manifest.book_count, 1);
    assert_eq!(lib.books.len(), 1);
    assert_eq!(lib.books[0].manifest.book.id, "bk_sample");
}

#[test]
fn streamed_fixture_loads_with_manifest_last() {
    // The streaming-writer fixture proves manifest-last ordering is loadable
    // by name-based readers: check the raw entry order, then parse normally.
    let bytes = fs::read(format!("{FIXTURE_DIR}/book-streamed.taletrek")).unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(&bytes[..])).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    assert_eq!(names.first().map(String::as_str), Some("text.json"));
    assert_eq!(names.last().map(String::as_str), Some("manifest.json"));
    drop(archive);

    let bundle = read_book_bundle(&bytes).unwrap();
    assert!(bundle.manifest.audio.present);
    assert_eq!(
        bundle.manifest.audio.codec,
        taletrek_synth::AudioCodec::Opus
    );
    // Chapter 2 repeats chapter 1's first paragraph — content addressing
    // collapses it, so 3 paragraphs = 2 segments.
    assert_eq!(bundle.chapters.len(), 2);
    assert_eq!(bundle.manifest.audio.segment_count, 2);
    assert_eq!(bundle.audio.len(), 2);
}

/// Regenerates the committed streaming fixture (`book-streamed.taletrek`) via
/// [`taletrek_synth::BundleWriter`]. Ignored by default — run explicitly with
/// `cargo test -p taletrek-synth --test fixtures_conformance -- --ignored
/// regenerate_streamed_fixture` when the fixture's shape must change, then
/// pair the edit with the web parity registration.
#[test]
#[ignore = "fixture regenerator — run explicitly to refresh the committed fixture"]
fn regenerate_streamed_fixture() {
    use std::collections::HashMap;
    use taletrek_synth::{
        cache_key, AudioCodec, AudioMeta, AudioSegment, BookMeta, BundleWriter, ChapterText,
        Generator, Manifest, ManifestKind, NORM_VERSION, SCHEMA_VERSION,
    };

    let voice = "en_US-lessac-medium";
    let chapters = vec![
        ChapterText::new(
            "bk_streamed",
            0,
            "Chapter One",
            vec![
                "Hello streamed world.".to_string(),
                "Second streamed paragraph.".to_string(),
            ],
        ),
        ChapterText::new(
            "bk_streamed",
            1,
            "Chapter Two",
            vec!["Hello streamed world.".to_string()], // repeated paragraph
        ),
    ];

    let mut seen: HashMap<String, AudioSegment> = HashMap::new();
    for ch in &chapters {
        for para in &ch.paragraphs {
            let key = cache_key(voice, para);
            if seen.contains_key(&key) {
                continue;
            }
            let seg = AudioSegment {
                key: key.clone(),
                codec: AudioCodec::Opus,
                bytes: format!("OggS-streamed-fixture-{key}").into_bytes(),
            };
            seen.insert(key, seg);
        }
    }

    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        kind: ManifestKind::Book,
        book: BookMeta {
            id: "bk_streamed".to_string(),
            title: "Streamed Sample".to_string(),
            author: Some("Fixture Generator".to_string()),
            source_format: "epub".to_string(),
            chapter_count: 2,
            voice_id: voice.to_string(),
            created_at: 1_780_000_000_000,
            updated_at: 1_780_000_000_000,
            progress_fraction: None,
        },
        audio: AudioMeta {
            present: true,
            codec: AudioCodec::Opus,
            norm_version: NORM_VERSION.parse().unwrap(),
            segment_count: seen.len() as u32,
        },
        generator: Generator {
            app: "taletrek-synth".to_string(),
            version: "0.1.0".to_string(),
        },
    };

    let mut writer = BundleWriter::new(Cursor::new(Vec::new()), &chapters).unwrap();
    // Feed paragraphs in book order, re-adding the repeat — the writer must
    // dedup it (the committed shape carries 2 audio entries, not 3).
    for ch in &chapters {
        for para in &ch.paragraphs {
            let key = cache_key(voice, para);
            let seg = seen.get(&key).unwrap();
            writer.add_segment(&key, seg).unwrap();
        }
    }
    assert_eq!(writer.segment_count(), 2);
    let bytes = writer.finish(manifest).unwrap().into_inner();
    fs::write(format!("{FIXTURE_DIR}/book-streamed.taletrek"), bytes).unwrap();
}
