//! Anti-drift round-trip: the segment keys [`BookIndex`] derives must equal
//! the `audio/` key set of a bundle written the way the writer writes it —
//! keys keyed by `cache_key(voice, paragraph_text)` (see
//! `crates/worker/src/synth_job.rs`). One `cache_key` derivation serves both
//! sides, and this test pins it: the bar efforts 4–5 inherit (spec success
//! criterion 7).

use std::collections::HashMap;

use taletrek_reader::BookIndex;
use taletrek_synth::bundle::audio::AudioCodec;
use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, Manifest, ManifestKind};
use taletrek_synth::bundle::BookBundle;
use taletrek_synth::{
    cache_key, read_audio_segment, read_book_bundle, write_book_bundle, AudioSegment, ChapterText,
    NORM_VERSION, SCHEMA_VERSION,
};

const VOICE: &str = "en_US-lessac-medium";

fn manifest(segment_count: u32) -> Manifest {
    Manifest {
        schema_version: SCHEMA_VERSION,
        kind: ManifestKind::Book,
        book: BookMeta {
            id: "bk_drift".into(),
            title: "Drift".into(),
            author: None,
            source_format: "txt".into(),
            chapter_count: 2,
            voice_id: VOICE.into(),
            created_at: 0,
            updated_at: 0,
            progress_fraction: None,
        },
        audio: AudioMeta {
            present: true,
            codec: AudioCodec::Opus,
            norm_version: NORM_VERSION.parse().unwrap(),
            segment_count,
        },
        generator: Generator {
            app: "taletrek-test".into(),
            version: "0.0.0".into(),
        },
    }
}

/// Two chapters; the last paragraph of chapter 1 repeats chapter 0's opening
/// text — duplicate texts collapse to one cache key, so the fixture exercises
/// key-SET semantics, not per-paragraph counting.
fn chapters() -> Vec<ChapterText> {
    vec![
        ChapterText::new(
            "bk_drift",
            0,
            "One",
            vec!["Hello world.".into(), "Second paragraph.".into()],
        ),
        ChapterText::new(
            "bk_drift",
            1,
            "Two",
            vec!["Across chapters.".into(), "Hello world.".into()],
        ),
    ]
}

/// The audio map exactly as the writer builds it: one segment per paragraph,
/// keyed by `cache_key(voice, text)`.
fn writer_audio(chapters: &[ChapterText]) -> HashMap<String, AudioSegment> {
    chapters
        .iter()
        .flat_map(|ch| ch.paragraphs.iter())
        .map(|text| {
            let key = cache_key(VOICE, text);
            (
                key.clone(),
                AudioSegment {
                    key,
                    codec: AudioCodec::Opus,
                    bytes: b"OggS".to_vec(),
                },
            )
        })
        .collect()
}

#[test]
fn derived_keys_equal_written_audio_keys_exactly() {
    let chapters = chapters();
    let audio = writer_audio(&chapters);
    let bundle = BookBundle {
        manifest: manifest(audio.len() as u32),
        chapters: chapters.clone(),
        audio,
    };

    // A real bundle on disk, read back through the real paths.
    let mut buf = std::io::Cursor::new(Vec::new());
    write_book_bundle(&bundle, &mut buf).unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("anti-drift.taletrek");
    std::fs::write(&path, buf.into_inner()).unwrap();
    let bytes = std::fs::read(&path).unwrap();

    // The archive's key set…
    let read_back = read_book_bundle(&bytes).unwrap();
    let archive_keys: std::collections::HashSet<String> = read_back.audio.keys().cloned().collect();

    // …≡ the BookIndex-derived key set (4 paragraphs, 3 distinct texts).
    let index = BookIndex::new(&read_back.manifest, &read_back.chapters);
    let derived: std::collections::HashSet<String> = index
        .chapters
        .iter()
        .flat_map(|ch| ch.paragraphs.iter())
        .map(|p| p.segment_key.clone())
        .collect();
    assert_eq!(derived.len(), 3);
    assert_eq!(archive_keys, derived);

    // And every derived key resolves through the per-paragraph disk read.
    for key in &derived {
        assert!(
            read_audio_segment(&path, key).unwrap().is_some(),
            "derived key {key} missing from the archive"
        );
    }
}
