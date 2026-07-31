//! Conformance: the committed fixtures under `tests/fixtures/` load cleanly and
//! their manifest fields match what the generator wrote. These archives are the
//! cross-language contract — the TS implementation (effort 3) must read them
//! unchanged.

use std::fs;

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
