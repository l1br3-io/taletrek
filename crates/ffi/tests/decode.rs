//! `decode_segment` round-trips — the one piece of the player surface
//! AVFoundation cannot host (OGG/Opus decode). Proves the wrapper over the
//! lifted desktop decode path against three lineages: the committed real
//! sherpa→native-opus fixture, our own encoder's output, and hand-built
//! 16-bit PCM WAV — plus the two failure shapes foreign callers branch on.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use taletrek_ffi::{decode_segment, open_book, FfiError};
use taletrek_synth::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
use taletrek_synth::bundle::AudioSegment;
use taletrek_synth::{
    write_book_bundle, AudioCodec, BookBundle, ChapterText, Manifest, NORM_VERSION, SCHEMA_VERSION,
};

/// The committed real-audio fixture (android-app T3): `just synth` of the
/// text-only sample through sherpa → native Opus — 3 × ~1 s OggS segments.
const PLAYABLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../synth/tests/fixtures/book-playable.taletrek"
);

const VOICE: &str = "en_US-amy-medium";
const PARA: &str = "One small paragraph for the ears.";

// --- helpers (the desktop reader suite's fixture vocabulary) -------------------

/// Canonical 44-byte mono 16-bit WAV around raw PCM at `rate`.
fn wav_bytes(pcm: &[i16], rate: u32) -> Vec<u8> {
    let data_len = u32::try_from(pcm.len() * 2).unwrap();
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// `secs` of a `freq` Hz sine at `rate`, amplitude 0.4.
fn sine(rate: u32, secs: f64, freq: f64) -> Vec<i16> {
    let total = (f64::from(rate) * secs).round() as usize;
    (0..total)
        .map(|i| {
            let t = f64::from(i as u32) / f64::from(rate);
            (0.4 * (2.0 * std::f64::consts::PI * freq * t).sin() * 32767.0) as i16
        })
        .collect()
}

/// Estimated Hz of a mono signal via zero-crossing count.
fn tone_hz(pcm: &[i16], rate: u32) -> f64 {
    let crossings = pcm.windows(2).filter(|w| (w[0] < 0) != (w[1] < 0)).count() as f64;
    crossings / 2.0 / (pcm.len() as f64 / f64::from(rate))
}

/// The paragraph fixture's segment key (the derivation reader and writer
/// share).
fn para_key() -> String {
    taletrek_synth::cache_key(VOICE, PARA)
}

/// A narrated one-paragraph bundle on disk carrying `segment` (or none)
/// under the paragraph's derived key, declaring `codec`.
fn narrated_bundle(segment: Option<Vec<u8>>, codec: AudioCodec) -> (tempfile::TempDir, PathBuf) {
    let key = para_key();
    let mut audio = HashMap::new();
    if let Some(bytes) = segment {
        audio.insert(key.clone(), AudioSegment { key, codec, bytes });
    }
    let bundle = BookBundle {
        manifest: Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_audio".into(),
                title: "Audio Fixture".into(),
                author: None,
                source_format: "txt".into(),
                chapter_count: 1,
                voice_id: VOICE.into(),
                created_at: 0,
                updated_at: 0,
                progress_fraction: None,
            },
            audio: AudioMeta {
                present: true,
                codec,
                norm_version: NORM_VERSION.parse().unwrap(),
                segment_count: audio.len().try_into().unwrap(),
            },
            generator: Generator {
                app: "taletrek-test".into(),
                version: "0.0.0".into(),
            },
        },
        chapters: vec![ChapterText::new("bk_audio", 0, "One", vec![PARA.into()])],
        audio,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book.taletrek");
    let mut buf = Cursor::new(Vec::new());
    write_book_bundle(&bundle, &mut buf).unwrap();
    fs::write(&path, buf.into_inner()).unwrap();
    (dir, path)
}

/// The libopus-native output rates (Hz) decode can land on.
const OPUS_RATES: [u32; 5] = [8_000, 12_000, 16_000, 24_000, 48_000];

// --- the committed real-audio fixture ------------------------------------------

#[test]
fn decodes_every_segment_of_the_playable_fixture() {
    let book = open_book(PLAYABLE.to_owned()).expect("fixture opens");
    assert!(book.audio_present, "fixture must carry audio");

    let keys: Vec<String> = book
        .chapters
        .iter()
        .flat_map(|ch| ch.paragraphs.iter().map(|p| p.segment_key.clone()))
        .collect();
    assert!(!keys.is_empty(), "fixture has paragraphs");

    for key in keys {
        let decoded = decode_segment(PLAYABLE.to_owned(), key.clone())
            .expect("read + decode")
            .unwrap_or_else(|| panic!("segment {key} must be present"));
        assert!(!decoded.samples.is_empty(), "{key}: PCM must be non-empty");
        assert!(
            OPUS_RATES.contains(&decoded.sample_rate),
            "{key}: rate {} must be libopus-native",
            decoded.sample_rate
        );
        assert!(decoded.channels >= 1, "{key}: mono at minimum");
        let frames = decoded.samples.len() / usize::from(decoded.channels);
        let dur = frames as f64 / f64::from(decoded.sample_rate);
        assert!(
            (0.5..=10.0).contains(&dur),
            "{key}: paragraph-scale segment, got {dur:.3} s"
        );
    }
}

// --- encode → decode round-trip through our own encoder ------------------------

#[test]
fn native_encoder_output_round_trips() {
    use taletrek_synth::{Encoder, NativeOpusEncoder};

    let rate = 16_000;
    let src = sine(rate, 3.0, 440.0);
    let opus = NativeOpusEncoder::new()
        .encode(&wav_bytes(&src, rate))
        .expect("encode");
    let (_dir, path) = narrated_bundle(Some(opus), AudioCodec::Opus);

    let decoded = decode_segment(path.to_string_lossy().into_owned(), para_key())
        .expect("read + decode")
        .expect("segment present");

    assert_eq!(decoded.channels, 1, "mono in, mono out");
    assert_eq!(decoded.sample_rate, 16_000, "16 kHz is libopus-native");
    assert!(
        decoded
            .samples
            .iter()
            .map(|s| s.unsigned_abs())
            .max()
            .unwrap()
            > 8_000,
        "decoded signal must carry the sine's amplitude"
    );
    let dur = decoded.samples.len() as f64 / f64::from(decoded.sample_rate);
    assert!(
        (dur - 3.0).abs() < 0.05,
        "duration {dur:.3} s vs 3.0 s source (preskip trimmed, ≤20 ms pad)"
    );
    let est = tone_hz(&decoded.samples, decoded.sample_rate);
    assert!(
        ((est - 440.0) / 440.0).abs() < 0.05,
        "tone drifted: {est:.1} Hz vs 440"
    );
}

// --- the WAV path ---------------------------------------------------------------

#[test]
fn wav_segment_decodes_exactly() {
    let pcm: Vec<i16> = (0..1000).map(|i| (i % 97 - 48) * 200).collect();
    let (_dir, path) = narrated_bundle(Some(wav_bytes(&pcm, 8_000)), AudioCodec::Wav);

    let decoded = decode_segment(path.to_string_lossy().into_owned(), para_key())
        .expect("read + decode")
        .expect("segment present");
    assert_eq!(decoded.samples, pcm, "16-bit PCM must round-trip exactly");
    assert_eq!(decoded.sample_rate, 8_000);
    assert_eq!(decoded.channels, 1);
}

// --- failure shapes --------------------------------------------------------------

#[test]
fn missing_key_is_none() {
    // Key-shaped but never synthesized; the playable fixture declares audio.
    let absent = format!("en_US-lessac-medium:2:{}", "ab".repeat(32));
    assert!(decode_segment(PLAYABLE.to_owned(), absent)
        .expect("read")
        .is_none());
}

#[test]
fn garbage_bytes_are_a_typed_decode_error() {
    let (_dir, path) =
        narrated_bundle(Some(b"not an ogg stream at all".to_vec()), AudioCodec::Opus);
    let err = decode_segment(path.to_string_lossy().into_owned(), para_key())
        .expect_err("garbage must fail");
    assert!(matches!(err, FfiError::DecodeFailed { .. }), "got: {err:?}");
}

#[test]
fn ogg_magic_with_corrupt_body_is_a_typed_decode_error() {
    let mut bytes = b"OggS".to_vec();
    bytes.extend_from_slice(&[0u8; 64]);
    let (_dir, path) = narrated_bundle(Some(bytes), AudioCodec::Opus);
    let err = decode_segment(path.to_string_lossy().into_owned(), para_key())
        .expect_err("corrupt ogg must fail");
    assert!(matches!(err, FfiError::DecodeFailed { .. }), "got: {err:?}");
}
