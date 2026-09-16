//! Fixture round-trips through the FFI wrappers — wrapper sanity, since
//! the logic these wrap is already covered in `crates/reader` and
//! `crates/synth`. Proves the surface foreign callers will use behaves:
//! open, segment read, the player walk, position save/restore, and the
//! text-only tolerance.

use taletrek_ffi::{
    open_book, position_storage_key, read_segment, FfiParagraphPos, FfiPlayerAction,
    FfiPlayerEvent, FfiPlayerStatus, FfiPosition, TrekPlayer,
};

const FULL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../synth/tests/fixtures/book-full.taletrek"
);
const TEXT_ONLY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../synth/tests/fixtures/book-text-only.taletrek"
);

/// The full fixture's paragraphs in reading order — 2 + 1.
fn paragraph_texts(book: &taletrek_ffi::FfiBook) -> Vec<String> {
    book.chapters
        .iter()
        .flat_map(|ch| ch.paragraphs.iter().map(|p| p.text.clone()))
        .collect()
}

/// A paragraph's segment key from the flattened book.
fn key_of(book: &taletrek_ffi::FfiBook, chapter: usize, index: usize) -> String {
    book.chapters[chapter].paragraphs[index].segment_key.clone()
}

// --- open_book ---------------------------------------------------------------

#[test]
fn open_book_flattens_the_full_fixture() {
    let book = open_book(FULL.to_owned()).expect("fixture opens");
    assert_eq!(book.book_id, "bk_sample");
    assert_eq!(book.title, "Sample Book");
    assert!(book.audio_present);
    assert_eq!(book.chapters.len(), 2);

    let ch0 = &book.chapters[0];
    assert_eq!(ch0.id, "ch_bk_sample_0");
    assert_eq!(ch0.title, "Chapter One");
    assert_eq!(ch0.paragraphs.len(), 2);
    assert_eq!(ch0.paragraphs[0].id, "ch_bk_sample_0:0");
    assert_eq!(ch0.paragraphs[0].text, "Hello world.");

    // Every paragraph carries a non-empty, distinct segment key.
    let keys: Vec<&str> = book
        .chapters
        .iter()
        .flat_map(|ch| ch.paragraphs.iter().map(|p| p.segment_key.as_str()))
        .collect();
    assert_eq!(keys.len(), 3);
    for key in &keys {
        assert!(!key.is_empty(), "keys must be non-empty");
    }
    let mut distinct = keys.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(distinct.len(), keys.len(), "keys must be distinct");

    let ch1 = &book.chapters[1];
    assert_eq!(ch1.paragraphs.len(), 1);
    assert_eq!(ch1.paragraphs[0].id, "ch_bk_sample_1:0");
}

#[test]
fn open_book_flags_a_text_only_bundle() {
    let book = open_book(TEXT_ONLY.to_owned()).expect("fixture opens");
    assert_eq!(book.book_id, "bk_sample");
    assert!(!book.audio_present);
    assert_eq!(paragraph_texts(&book).len(), 3);
}

#[test]
fn open_book_round_trips_the_author() {
    let book = open_book(FULL.to_owned()).expect("fixture opens");
    assert_eq!(book.author.as_deref(), Some("Fixture Generator"));
}

#[test]
fn open_book_maps_a_missing_file_to_the_io_error() {
    let err = open_book("/nonexistent-taletrek-ffi-test/bundle.taletrek".to_owned())
        .expect_err("missing file must fail");
    assert!(
        matches!(err, taletrek_ffi::FfiError::Io { .. }),
        "got: {err:?}"
    );
}

// --- read_segment --------------------------------------------------------------

#[test]
fn read_segment_returns_bytes_for_a_known_key() {
    let book = open_book(FULL.to_owned()).expect("fixture opens");
    let seg = read_segment(FULL.to_owned(), key_of(&book, 0, 0))
        .expect("read")
        .expect("segment present");
    assert!(seg.len() > 4, "segment carries real bytes");
    // The fixture's segments are synthetic payloads — the committed bytes
    // are the contract (same convention as the desktop decode fixtures).
    assert!(seg.starts_with(b"OG OpusHead"));
}

#[test]
fn read_segment_returns_none_for_an_absent_key() {
    // Key-shaped (`voice:norm:sha256`) but never synthesized.
    let absent = format!("en_US-lessac-medium:2:{}", "ab".repeat(32));
    assert!(read_segment(FULL.to_owned(), absent)
        .expect("read")
        .is_none());
}

// --- the player walk -----------------------------------------------------------

#[test]
fn play_walks_the_whole_book_to_a_terminal_stop() {
    let flat = open_book(FULL.to_owned()).expect("fixture opens");
    let player = TrekPlayer::new(flat.clone());

    let mut snap = player.state_snapshot();
    assert_eq!(snap.status, FfiPlayerStatus::Idle);
    assert!(snap.para.is_none());

    // Play loads the first paragraph.
    match player.tick(FfiPlayerEvent::Play) {
        FfiPlayerAction::LoadSegment { key, offset } => {
            assert_eq!(key, key_of(&flat, 0, 0));
            assert_eq!(offset, 0.0);
        }
        other => panic!("expected LoadSegment, got {other:?}"),
    }
    snap = player.state_snapshot();
    assert_eq!(snap.status, FfiPlayerStatus::Playing);

    // Drain every paragraph; the machine commands book order, then Stop.
    let mut loaded: Vec<String> = Vec::new();
    let mut action = FfiPlayerAction::LoadSegment {
        key: key_of(&flat, 0, 0),
        offset: 0.0,
    };
    let mut steps = 0;
    loop {
        steps += 1;
        assert!(steps < 10, "drain walk must terminate");
        match action {
            FfiPlayerAction::LoadSegment { key, .. } => {
                loaded.push(key.clone());
                action = player.tick(FfiPlayerEvent::SegmentDrained { key });
            }
            FfiPlayerAction::Stop => break,
            FfiPlayerAction::None => panic!("unexpected None during the walk"),
        }
    }

    let final_snap = player.state_snapshot();
    assert_eq!(
        final_snap.status,
        FfiPlayerStatus::Idle,
        "book ends at rest"
    );
    let all_keys: Vec<String> = flat
        .chapters
        .iter()
        .flat_map(|ch| ch.paragraphs.iter().map(|p| p.segment_key.clone()))
        .collect();
    assert_eq!(loaded, all_keys, "every paragraph played, in book order");
}

#[test]
fn pause_stops_output_and_play_resumes_at_the_offset() {
    let flat = open_book(FULL.to_owned()).expect("fixture opens");
    let player = TrekPlayer::new(flat.clone());
    let _ = player.tick(FfiPlayerEvent::Play);

    let action = player.tick(FfiPlayerEvent::Pause);
    assert!(matches!(action, FfiPlayerAction::Stop));
    assert_eq!(player.state_snapshot().status, FfiPlayerStatus::Paused);

    // Scrub while paused records only; play then loads from that offset.
    let _ = player.tick(FfiPlayerEvent::SeekWithinParagraph { offset: 2.5 });
    let action = player.tick(FfiPlayerEvent::Play);
    match action {
        FfiPlayerAction::LoadSegment { key, offset } => {
            assert_eq!(key, key_of(&flat, 0, 0));
            assert_eq!(offset, 2.5);
        }
        other => panic!("expected LoadSegment, got {other:?}"),
    }
}

// --- position ------------------------------------------------------------------

#[test]
fn position_captures_and_restores_round_trip() {
    let flat = open_book(FULL.to_owned()).expect("fixture opens");
    let player = TrekPlayer::new(flat.clone());
    let _ = player.tick(FfiPlayerEvent::Play);
    // Advance one paragraph so the position is not merely the start.
    let _ = player.tick(FfiPlayerEvent::SegmentDrained {
        key: key_of(&flat, 0, 0),
    });

    let pos = player.position().expect("playing has a position");
    assert_eq!(pos.chapter, 0);
    assert_eq!(pos.index, 1);

    let restored = TrekPlayer::restore(flat, pos);
    let snap = restored.state_snapshot();
    assert_eq!(snap.status, FfiPlayerStatus::Paused);
    assert_eq!(
        snap.para,
        Some(FfiParagraphPos {
            chapter: 0,
            index: 1
        })
    );

    // Resume loads the restored paragraph at the restored offset.
    match restored.tick(FfiPlayerEvent::Play) {
        FfiPlayerAction::LoadSegment { key, offset } => {
            let flat = open_book(FULL.to_owned()).expect("fixture opens");
            assert_eq!(key, key_of(&flat, 0, 1));
            assert_eq!(offset, snap.offset);
        }
        other => panic!("expected LoadSegment, got {other:?}"),
    }
}

#[test]
fn restore_sanitizes_hostile_offsets_to_paused_at_zero() {
    let flat = open_book(FULL.to_owned()).expect("fixture opens");
    for hostile in [-3.0, f64::NAN, f64::INFINITY] {
        let restored = TrekPlayer::restore(
            flat.clone(),
            FfiPosition {
                chapter: 0,
                index: 0,
                offset: hostile,
            },
        );
        let snap = restored.state_snapshot();
        assert_eq!(snap.status, FfiPlayerStatus::Paused, "raw {hostile}");
        assert_eq!(snap.offset, 0.0, "raw {hostile} must land on zero");
    }
}

#[test]
fn restore_with_an_out_of_range_position_seeds_idle() {
    let flat = open_book(FULL.to_owned()).expect("fixture opens");
    let restored = TrekPlayer::restore(
        flat,
        FfiPosition {
            chapter: 9,
            index: 9,
            offset: 1.0,
        },
    );
    let snap = restored.state_snapshot();
    assert_eq!(snap.status, FfiPlayerStatus::Idle);
    assert!(snap.para.is_none());
    assert_eq!(restored.position(), None);
}

#[test]
fn storage_key_names_the_book_under_the_reader_namespace() {
    assert_eq!(
        position_storage_key("bk_sample".to_owned()),
        "taletrek.reader.position.bk_sample"
    );
}

// --- text-only tolerance ---------------------------------------------------------

#[test]
fn text_only_book_absorbs_every_event() {
    let flat = open_book(TEXT_ONLY.to_owned()).expect("fixture opens");
    let player = TrekPlayer::new(flat);
    let events = vec![
        FfiPlayerEvent::Play,
        FfiPlayerEvent::Pause,
        FfiPlayerEvent::NextParagraph,
        FfiPlayerEvent::PrevParagraph,
        FfiPlayerEvent::NextChapter,
        FfiPlayerEvent::PrevChapter,
        FfiPlayerEvent::SeekToParagraph {
            pos: FfiParagraphPos {
                chapter: 0,
                index: 0,
            },
        },
        FfiPlayerEvent::SeekWithinParagraph { offset: 1.0 },
        FfiPlayerEvent::SegmentDrained {
            key: "any".to_owned(),
        },
        FfiPlayerEvent::SegmentFailed {
            key: "any".to_owned(),
            error: "x".to_owned(),
        },
    ];
    for ev in events {
        assert!(
            matches!(player.tick(ev.clone()), FfiPlayerAction::None),
            "{ev:?} must be a no-op on a text-only book"
        );
    }
    let snap = player.state_snapshot();
    assert_eq!(snap.status, FfiPlayerStatus::Idle);
    assert_eq!(player.position(), None);
}
