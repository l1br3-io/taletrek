//! `export_merged_audio` over the FFI surface — the whole-book merge's
//! foreign entry point. The committed fixtures carry synthetic payloads
//! (not valid OGG), so these tests build a real bundle in a tempdir:
//! segments encoded by the same native encoder the pipeline uses, then
//! merged through the exact call Kotlin will make.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;

use taletrek_ffi::{export_merged_audio, FfiError};
use taletrek_synth::{
    cache_key, write_book_bundle, AudioCodec, AudioMeta, AudioSegment, BookBundle, BookMeta,
    ChapterText, Encoder, Generator, Manifest, ManifestKind, NativeOpusEncoder, NORM_VERSION,
    SCHEMA_VERSION,
};

const VOICE: &str = "en_US-lessac-medium";
const RATE: u32 = 16_000;

/// Encode `secs` of a sine through the real native encoder — what a
/// produced bundle's `audio/` entries actually are.
fn encoded_sine(freq: f64, secs: f64) -> Vec<u8> {
    // Minimal canonical 44-byte mono WAV around the PCM (opus_native's
    // test shape; a copy here keeps the harness self-contained).
    let total = (f64::from(RATE) * secs).round() as usize;
    let pcm: Vec<i16> = (0..total)
        .map(|i| {
            let t = f64::from(i as u32) / f64::from(RATE);
            (0.4 * (2.0 * std::f64::consts::PI * freq * t).sin() * 32767.0) as i16
        })
        .collect();
    let data_len = (pcm.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&RATE.to_le_bytes());
    wav.extend_from_slice(&(RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for s in &pcm {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    NativeOpusEncoder::new().encode(&wav).unwrap()
}

/// A real two-segment audio bundle on disk; returns (tempdir, bundle path).
fn audio_bundle_on_disk(author: Option<&str>) -> (tempfile::TempDir, std::path::PathBuf) {
    let paragraphs = ["First fixture paragraph.", "Second fixture paragraph."];
    let freqs = [440.0, 620.0];
    let mut audio = HashMap::new();
    for (para, freq) in paragraphs.iter().zip(freqs) {
        audio.insert(
            cache_key(VOICE, para),
            AudioSegment {
                key: cache_key(VOICE, para),
                codec: AudioCodec::Opus,
                bytes: encoded_sine(freq, 0.4),
            },
        );
    }
    let bundle = BookBundle {
        manifest: Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_export".into(),
                title: "Export Fixture".into(),
                author: author.map(Into::into),
                source_format: "txt".into(),
                chapter_count: 1,
                voice_id: VOICE.into(),
                created_at: 0,
                updated_at: 0,
                progress_fraction: None,
            },
            audio: AudioMeta {
                present: true,
                codec: AudioCodec::Opus,
                norm_version: NORM_VERSION.parse().unwrap(),
                segment_count: 2,
            },
            generator: Generator {
                app: "taletrek-export-test".into(),
                version: "0.0.0".into(),
            },
        },
        chapters: vec![ChapterText::new(
            "bk_export",
            0,
            "Chapter",
            paragraphs.iter().map(|p| p.to_string()).collect(),
        )],
        audio,
    };
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("bundle.taletrek");
    let mut buf = Cursor::new(Vec::new());
    write_book_bundle(&bundle, &mut buf).unwrap();
    fs::write(&path, buf.into_inner()).unwrap();
    (tmp, path)
}

#[test]
fn export_writes_a_nonempty_single_stream_opus_and_counts_segments() {
    let (tmp, bundle) = audio_bundle_on_disk(Some("Fixture Author"));
    let dest = tmp.path().join("exports").join("book.opus");
    fs::create_dir_all(dest.parent().unwrap()).unwrap();

    let segments = export_merged_audio(
        bundle.to_string_lossy().into_owned(),
        dest.to_string_lossy().into_owned(),
    )
    .expect("export succeeds");
    assert_eq!(segments, 2);

    let bytes = fs::read(&dest).expect("dest written");
    assert!(bytes.len() > 100, "non-empty opus: {} bytes", bytes.len());
    assert_eq!(&bytes[..4], b"OggS", "OGG container");
    // One stream: BOS on the first page, EOS on the last, nowhere else.
    assert_eq!(bytes[5] & 0x02, 0x02, "first page is BOS");
    let last = bytes
        .windows(4)
        .rposition(|w| w == b"OggS")
        .expect("a page exists");
    assert_eq!(bytes[last + 5] & 0x04, 0x04, "last page is EOS");
}

#[test]
fn export_of_a_text_only_bundle_is_a_typed_error() {
    let (tmp, bundle_path) = audio_bundle_on_disk(None);
    // Rewrite as text-only: present=false, no audio entries.
    let bytes = fs::read(&bundle_path).unwrap();
    let mut text_only = taletrek_synth::read_book_bundle(&bytes).unwrap();
    text_only.manifest.audio.present = false;
    text_only.audio.clear();
    let only = tmp.path().join("text-only.taletrek");
    let mut buf = Cursor::new(Vec::new());
    taletrek_synth::write_book_bundle(&text_only, &mut buf).unwrap();
    fs::write(&only, buf.into_inner()).unwrap();

    let err = export_merged_audio(
        only.to_string_lossy().into_owned(),
        tmp.path().join("out.opus").to_string_lossy().into_owned(),
    )
    .expect_err("text-only must fail");
    assert!(matches!(err, FfiError::MergeFailed { .. }), "got: {err:?}");
}
