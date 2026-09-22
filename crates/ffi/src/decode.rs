//! Segment decode for foreign callers — the one player capability a
//! platform audio stack cannot host itself: AVFoundation has no
//! OGG/Opus decoder, so decode stays in the kernel (kernel-decides
//! discipline) and crosses as flattened PCM.
//!
//! The OGG/Opus body is the desktop reader's proven decode
//! (`desktop/src/gui/reader/audio.rs`, reader-page task 001), moved
//! not rewritten: `ogg` demux + `opus` (libopus via opusic-sys) of one
//! segment's bytes — the same crates `taletrek-synth`'s
//! `NativeOpusEncoder` used to *write* those bytes, so container and
//! codec agree by construction. WAV segments (16-bit PCM) decode in
//! the same wrapper; legacy **m4a** segments are v1 out-of-scope on
//! iOS and surface as [`FfiError::DecodeFailed`] — the platform maps
//! that onto the kernel's segment-skip path, never a crash.

use std::io::Cursor;
use std::path::Path;

use ogg::PacketReader;
use opus::Channels;
use taletrek_synth::read_audio_segment;

use crate::error::FfiError;

/// One segment's decoded audio as foreign callers receive it:
/// interleaved i16 PCM at `sample_rate`, the libopus-native rate
/// nearest the voice's original rate (Opus decode is always
/// whole-stream single-rate; 22050 Hz voices decode at 24 kHz).
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiDecodedAudio {
    /// Interleaved PCM samples (i16, native endianness flattened to LE).
    pub samples: Vec<i16>,
    /// The PCM's sample rate (Hz) — schedule it at this rate.
    pub sample_rate: u32,
    /// Channel count (1 = mono, 2 = stereo).
    pub channels: u8,
}

/// The decode-internal result before flattening to the record.
struct DecodedSegment {
    samples: Vec<i16>,
    sample_rate: u32,
    channels: usize,
}

/// Output rates libopus can decode to natively (Hz); anything else decodes
/// at the nearest entry.
const OPUS_RATES: [u32; 5] = [8_000, 12_000, 16_000, 24_000, 48_000];

/// Max samples per channel libopus emits for one packet (120 ms @ 48 kHz).
const MAX_FRAME: usize = 5_760;

/// The libopus-native output rate closest to `rate` (22050 → 24000).
fn nearest_rate(rate: u32) -> u32 {
    OPUS_RATES
        .into_iter()
        .min_by_key(|r| r.abs_diff(rate))
        .unwrap_or(48_000)
}

/// Decode a full OGG/Opus byte slice (one paragraph segment's file) to
/// interleaved PCM. The OpusHead's original input rate picks the output
/// rate; its preskip (the encoder's lookahead) is trimmed so decoded time
/// aligns with authored time.
fn decode_ogg_opus(bytes: &[u8]) -> Result<DecodedSegment, String> {
    let mut rdr = PacketReader::new(Cursor::new(bytes));

    // First packet must be OpusHead (RFC 7845 §5.1): channels @9, preskip
    // (48 kHz-domain) @10..12, original input rate (advisory) @12..16.
    let head = rdr
        .read_packet()
        .map_err(|e| format!("first OGG packet: {e}"))?
        .ok_or_else(|| "empty OGG stream".to_owned())?;
    if head.data.len() < 16 || !head.data.starts_with(b"OpusHead") {
        return Err("first packet is not an OpusHead".to_owned());
    }
    let ch_count = head.data[9] as usize;
    let channels = match ch_count {
        1 => Channels::Mono,
        2 => Channels::Stereo,
        n => return Err(format!("unsupported channel count {n}")),
    };
    let preskip = u16::from_le_bytes(head.data[10..12].try_into().expect("len checked"));
    let input_rate = u32::from_le_bytes(head.data[12..16].try_into().expect("len checked"));
    let sample_rate = nearest_rate(input_rate);

    let mut dec =
        opus::Decoder::new(sample_rate, channels).map_err(|e| format!("decoder create: {e}"))?;

    // preskip lives in the 48 kHz granule domain — scale it into the output
    // rate's domain, then trim that many leading samples.
    let skip = (u32::from(preskip) as u64 * u64::from(sample_rate) / 48_000) as usize;

    let mut samples: Vec<i16> = Vec::new();
    while let Some(pkt) = rdr.read_packet().map_err(|e| format!("OGG read: {e}"))? {
        if pkt.data.starts_with(b"OpusTags") {
            continue;
        }
        let mut frame = vec![0i16; MAX_FRAME * ch_count];
        let n = dec
            .decode(&pkt.data, &mut frame, false)
            .map_err(|e| format!("packet decode: {e}"))?;
        samples.extend_from_slice(&frame[..n * ch_count]);
    }
    if samples.is_empty() {
        return Err("stream carried no audio packets".to_owned());
    }
    let dropped = skip.min(samples.len());
    samples.drain(..dropped);

    Ok(DecodedSegment {
        samples,
        sample_rate,
        channels: ch_count,
    })
}

/// Decode a 16-bit PCM RIFF/WAVE byte slice to interleaved PCM — the
/// minimal canonical parse: walk the top-level chunks, take the first
/// `fmt ` and `data`, require PCM (`wFormatTag` 1) mono/stereo at 16
/// bits. The samples are the file's bytes verbatim (little-endian i16).
fn decode_wav(bytes: &[u8]) -> Result<DecodedSegment, String> {
    if bytes.len() < 12 || &bytes[8..12] != b"WAVE" {
        return Err("RIFF stream is not a WAVE file".to_owned());
    }
    let mut fmt: Option<&[u8]> = None;
    let mut data: Option<&[u8]> = None;
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size =
            u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().expect("len checked")) as usize;
        let body_start = pos + 8;
        let body_end = body_start.saturating_add(size).min(bytes.len());
        if id == b"fmt " && fmt.is_none() {
            fmt = Some(&bytes[body_start..body_end]);
        } else if id == b"data" && data.is_none() {
            data = Some(&bytes[body_start..body_end]);
        }
        // RIFF chunks are word-aligned: odd sizes carry one pad byte.
        let Some(next) = pos
            .checked_add(8)
            .and_then(|p| p.checked_add(size))
            .and_then(|p| p.checked_add(size & 1))
        else {
            break;
        };
        pos = next;
    }
    let fmt = fmt.ok_or_else(|| "WAV stream carries no fmt chunk".to_owned())?;
    if fmt.len() < 16 {
        return Err("WAV fmt chunk is truncated".to_owned());
    }
    let format_tag = u16::from_le_bytes(fmt[0..2].try_into().expect("len checked"));
    if format_tag != 1 {
        return Err(format!("WAV stream is not PCM (format tag {format_tag})"));
    }
    let channels = u16::from_le_bytes(fmt[2..4].try_into().expect("len checked")) as usize;
    if channels == 0 || channels > 2 {
        return Err(format!("unsupported channel count {channels}"));
    }
    let bits = u16::from_le_bytes(fmt[14..16].try_into().expect("len checked"));
    if bits != 16 {
        return Err(format!("WAV stream is not 16-bit (got {bits})"));
    }
    let data = data.ok_or_else(|| "WAV stream carries no data chunk".to_owned())?;
    if data.is_empty() {
        return Err("WAV data chunk is empty".to_owned());
    }
    let sample_rate = u32::from_le_bytes(fmt[4..8].try_into().expect("len checked"));
    let usable = data.len() - data.len() % 2;
    let samples = data[..usable]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes(pair.try_into().expect("chunks_exact(2)")))
        .collect();
    Ok(DecodedSegment {
        samples,
        sample_rate,
        channels,
    })
}

/// Read one audio segment from the bundle at `path` and decode it to
/// PCM — the single hop a platform player needs when its own audio
/// stack cannot host the codec. `None` when the archive carries no
/// segment for `key` (the same contract as [`read_segment`]); bytes
/// that are neither OGG/Opus nor 16-bit PCM WAV fail as
/// [`FfiError::DecodeFailed`] — the segment-skip path, never a panic.
#[uniffi::export]
pub fn decode_segment(path: String, key: String) -> Result<Option<FfiDecodedAudio>, FfiError> {
    let Some(segment) = read_audio_segment(Path::new(&path), &key)? else {
        return Ok(None);
    };
    decode_segment_bytes(segment.bytes).map(Some)
}

/// Decode one segment's encoded bytes — verbatim what
/// [`crate::read_segment_progressive`] hands back in
/// [`FfiSegmentStatus::Ready`] — to PCM. The progressive flow's decode
/// hop: the bytes are already in the caller's hands (often from the
/// segment store, not the archive), so the dispatch is the same
/// magic-bytes split `decode_segment` applies. Same codec contract
/// (`opus`/`wav`; m4a legacy segments fail as `DecodeFailed` — the
/// documented fail-skip).
#[uniffi::export]
pub fn decode_segment_bytes(bytes: Vec<u8>) -> Result<FfiDecodedAudio, FfiError> {
    let decoded = if bytes.starts_with(b"OggS") {
        decode_ogg_opus(&bytes)
    } else if bytes.starts_with(b"RIFF") {
        decode_wav(&bytes)
    } else {
        Err(
            "segment is neither an OGG/Opus nor a RIFF/WAV stream (m4a legacy \
             segments are not decodable on this surface)"
                .to_owned(),
        )
    }
    .map_err(|detail| FfiError::DecodeFailed { detail })?;
    Ok(FfiDecodedAudio {
        samples: decoded.samples,
        sample_rate: decoded.sample_rate,
        channels: u8::try_from(decoded.channels).expect("decode enforces ≤ 2 channels"),
    })
}
