//! Minimal canonical WAV byte manipulation — a faithful Rust port of the SPA's
//! `web/src/lib/tts/vendor/piper/pcm.ts` (`concatWav` + `findDataOffset`) and
//! `web/src/lib/audio/ffmpeg.ts` (`parseWavDuration`).
//!
//! Piper emits canonical mono 16-bit PCM WAV. [`concat_wav`] splices the PCM
//! payloads of N such WAVs into one, copying the first input's `fmt ` chunk
//! verbatim and rewriting the two size fields. [`wav_duration`] reads the `fmt`
//! + `data` chunks to compute playback seconds.

/// Concatenate multiple canonical-mono-16-bit WAV byte slices into one WAV.
///
/// Mirrors the SPA's `concatWav`: empty input → empty output; single input →
/// returned as-is; otherwise the first input's header (up to its `data` chunk)
/// is copied, the RIFF size (offset 4) and the `data` chunk size are rewritten,
/// and every input's PCM payload is appended in order. Assumes all inputs
/// share sample rate + channel count (Piper always does — one voice = one
/// config). No re-decoding: a byte-level splice.
#[must_use]
pub fn concat_wav(buffers: &[Vec<u8>]) -> Vec<u8> {
    if buffers.is_empty() {
        return Vec::new();
    }
    if buffers.len() == 1 {
        return buffers[0].clone();
    }

    // Locate the `data` offset in each input and sum the payload sizes.
    let mut data_offsets = Vec::with_capacity(buffers.len());
    let mut total_data_bytes = 0usize;
    for buf in buffers {
        let off = find_data_offset(buf);
        data_offsets.push(off);
        total_data_bytes += buf.len().saturating_sub(off);
    }

    let first = &buffers[0];
    let header_len = data_offsets[0];
    let mut out = Vec::with_capacity(header_len + total_data_bytes);
    out.extend_from_slice(&first[..header_len]);

    let total_data_bytes_u32 = u32::try_from(total_data_bytes).unwrap_or(u32::MAX);

    // Rewrite RIFF size (offset 4): 36 + totalDataBytes (canonical 44-byte header
    // → 44 − 8 = 36). Faithful to the SPA even though it assumes canonical input.
    if out.len() >= 8 {
        out[4..8].copy_from_slice(&(36 + total_data_bytes_u32).to_le_bytes());
    }

    // Scan the copied header for the `data` chunk and fix its size field.
    let mut scan = 12usize;
    while scan + 8 <= header_len {
        if &out[scan..scan + 4] == b"data" {
            out[scan + 4..scan + 8].copy_from_slice(&total_data_bytes_u32.to_le_bytes());
            break;
        }
        let size = u32::from_le_bytes(out[scan + 4..scan + 8].try_into().unwrap_or([0; 4]));
        let pad = (size % 2) as usize;
        scan += 8 + size as usize + pad;
    }

    // Append PCM bytes from each input.
    for (i, buf) in buffers.iter().enumerate() {
        let off = data_offsets[i];
        out.extend_from_slice(&buf[off..]);
    }

    out
}

/// Playback duration (seconds) of an OGG Opus stream, read from the last
/// page's granule position minus the `OpusHead` preskip (the 48 kHz granule
/// clock) — a manual page walk, deliberately free of the `ogg` dependency
/// so callers without feature `native-encode` (the worker's resume path
/// timing store segments) can time encoded audio. Malformed input yields
/// `0.0`; well-formed streams agree with the `ogg` reader to the sample.
#[must_use]
pub fn opus_duration_seconds(bytes: &[u8]) -> f64 {
    let mut last_granule: Option<u64> = None;
    let mut preskip: Option<u64> = None;
    let mut at = 0usize;
    while at + 27 <= bytes.len() {
        if &bytes[at..at + 4] != b"OggS" {
            at += 1;
            continue;
        }
        let granule = u64::from_le_bytes(bytes[at + 6..at + 14].try_into().unwrap_or([0; 8]));
        let nsegs = bytes[at + 26] as usize;
        let table_end = at + 27 + nsegs;
        if table_end > bytes.len() {
            break;
        }
        // The OpusHead packet (when it starts here) carries preskip at
        // packet offset 10..12; a packet beginning on this page starts
        // after the lacing table, and the table's first entry is its
        // length.
        if preskip.is_none() && nsegs > 0 {
            let first_len = bytes[at + 27] as usize;
            let packet = table_end;
            if first_len >= 19
                && packet + first_len <= bytes.len()
                && &bytes[packet..packet + 8] == b"OpusHead"
            {
                preskip = Some(u64::from(u16::from_le_bytes([
                    bytes[packet + 10],
                    bytes[packet + 11],
                ])));
            }
        }
        // Page payload size = sum of the lacing values.
        let mut payload = 0usize;
        for &lacing in &bytes[at + 27..table_end] {
            payload += lacing as usize;
        }
        if granule != u64::MAX {
            last_granule = Some(granule);
        }
        at = table_end + payload;
    }
    match (last_granule, preskip) {
        (Some(granule), Some(skip)) if granule > skip => (granule - skip) as f64 / 48_000.0,
        _ => 0.0,
    }
}

/// Parse the playback duration (seconds) of a PCM WAV byte slice by reading the
/// `fmt` and `data` chunk headers. Mirrors the SPA's `parseWavDuration`.
///
/// Returns `0.0` for inputs shorter than the canonical 44-byte header or for
/// WAVs whose `fmt` chunk is missing or carries a zero byte rate.
#[must_use]
pub fn wav_duration(data: &[u8]) -> f64 {
    if data.len() < 44 {
        return 0.0;
    }
    let mut sample_rate = 0u32;
    let mut channels = 0u16;
    let mut bits_per_sample = 0u16;

    let mut offset = 12usize;
    while offset + 8 <= data.len() {
        let id = &data[offset..offset + 4];
        let size = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap_or([0; 4]));
        if id == b"fmt " {
            // fmt body starts at offset+8: audio_format(u16), channels(u16),
            // sample_rate(u32), byte_rate(u32), block_align(u16), bits(u16).
            if offset + 10 + 2 <= data.len() {
                channels =
                    u16::from_le_bytes(data[offset + 10..offset + 12].try_into().unwrap_or([0; 2]));
            }
            if offset + 12 + 4 <= data.len() {
                sample_rate =
                    u32::from_le_bytes(data[offset + 12..offset + 16].try_into().unwrap_or([0; 4]));
            }
            if offset + 22 + 2 <= data.len() {
                bits_per_sample =
                    u16::from_le_bytes(data[offset + 22..offset + 24].try_into().unwrap_or([0; 2]));
            }
        } else if id == b"data" {
            let byte_rate =
                u64::from(sample_rate) * u64::from(channels) * u64::from(bits_per_sample) / 8;
            return if byte_rate > 0 {
                u64::from(size) as f64 / byte_rate as f64
            } else {
                0.0
            };
        }
        let pad = (size % 2) as usize;
        offset += 8 + size as usize + pad;
    }
    0.0
}

/// Borrowed PCM view of a canonical WAV: `(channels, sample_rate,
/// bits_per_sample, data slice)`.
///
/// Scans the same chunk table as [`wav_duration`]; returns `None` for inputs
/// shorter than the RIFF header, with a missing/unparsed `fmt ` or `data`
/// chunk, or with zero `fmt` fields. The data slice is clamped to the bytes
/// actually present. Crate-internal consumer: the native Opus encoder.
#[cfg(feature = "native-encode")]
pub(crate) fn pcm_view(data: &[u8]) -> Option<(u16, u32, u16, &[u8])> {
    if data.len() < 12 {
        return None;
    }
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;

    let mut offset = 12usize;
    while offset + 8 <= data.len() {
        let id = &data[offset..offset + 4];
        let size = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().ok()?);
        if id == b"fmt " {
            if offset + 10 + 2 <= data.len() {
                channels = u16::from_le_bytes(data[offset + 10..offset + 12].try_into().ok()?);
            }
            if offset + 12 + 4 <= data.len() {
                sample_rate = u32::from_le_bytes(data[offset + 12..offset + 16].try_into().ok()?);
            }
            if offset + 22 + 2 <= data.len() {
                bits_per_sample =
                    u16::from_le_bytes(data[offset + 22..offset + 24].try_into().ok()?);
            }
        } else if id == b"data" {
            if channels == 0 || sample_rate == 0 || bits_per_sample == 0 {
                return None;
            }
            let start = offset + 8;
            let end = start.checked_add(size as usize)?.min(data.len());
            return Some((channels, sample_rate, bits_per_sample, &data[start..end]));
        }
        let pad = (size % 2) as usize;
        offset += 8 + size as usize + pad;
    }
    None
}

/// Locate the start of the PCM data payload (byte offset of the first sample,
/// i.e. 8 bytes past the `data` FourCC). Scans the chunk table from offset 12;
/// falls back to `min(len, 44)` if the structure is unexpected — same fallback
/// as the SPA's `findDataOffset` / `parseWavDuration`.
fn find_data_offset(buf: &[u8]) -> usize {
    if buf.len() < 12 {
        return buf.len().min(44);
    }
    let mut offset = 12usize;
    while offset + 8 <= buf.len() {
        let id = &buf[offset..offset + 4];
        let size = u32::from_le_bytes(buf[offset + 4..offset + 8].try_into().unwrap_or([0; 4]));
        if id == b"data" {
            return offset + 8;
        }
        let pad = (size % 2) as usize;
        offset += 8 + size as usize + pad;
    }
    buf.len().min(44)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical mono 16-bit 16 kHz WAV with the given PCM payload.
    fn wav(pcm: &[u8]) -> Vec<u8> {
        let data_len = u32::try_from(pcm.len()).unwrap();
        let mut out = Vec::with_capacity(44 + pcm.len());
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&16_000u32.to_le_bytes());
        out.extend_from_slice(&32_000u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.extend_from_slice(pcm);
        out
    }

    #[test]
    fn concat_empty_is_empty() {
        assert!(concat_wav(&[]).is_empty());
    }

    #[test]
    fn concat_single_is_clone() {
        let one = wav(&[1, 2, 3]);
        assert_eq!(concat_wav(std::slice::from_ref(&one)), one);
    }

    #[test]
    fn concat_two_splices_payloads_and_fixes_sizes() {
        let a = wav(&[0x10, 0x20]);
        let b = wav(&[0x30, 0x40, 0x50, 0x60]);
        let out = concat_wav(&[a, b]);

        // One 44-byte header + 6 payload bytes.
        assert_eq!(out.len(), 44 + 6);
        // The header should match a single WAV carrying the full 6-byte payload
        // (concat rewrote the RIFF + data sizes to cover the splice).
        assert_eq!(&out[..44], &wav(&[0u8; 6])[..44]);
        assert_eq!(&out[44..], &[0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);

        // RIFF size = 36 + 6, data size = 6 (explicit double-check).
        assert_eq!(&out[4..8], &(36u32 + 6).to_le_bytes());
        assert_eq!(&out[40..44], &6u32.to_le_bytes());
    }

    #[test]
    fn duration_of_known_wav() {
        // 32000 byte/s, 16 bytes → 0.0005 s.
        let w = wav(&[0u8; 16]);
        let d = wav_duration(&w);
        assert!((d - 16.0 / 32_000.0).abs() < 1e-9);
    }

    #[test]
    fn duration_of_truncated_input_is_zero() {
        assert_eq!(wav_duration(&[0u8; 10]), 0.0);
    }

    #[test]
    #[cfg(feature = "native-encode")]
    fn pcm_view_of_known_wav_returns_fields_and_payload() {
        let w = wav(&[0x10, 0x20, 0x30, 0x40]);
        let (channels, rate, bits, data) = pcm_view(&w).unwrap();
        assert_eq!((channels, rate, bits), (1, 16_000, 16));
        assert_eq!(data, &[0x10, 0x20, 0x30, 0x40]);
    }

    #[test]
    #[cfg(feature = "native-encode")]
    fn pcm_view_of_garbage_is_none() {
        assert!(pcm_view(&[]).is_none());
        assert!(pcm_view(&[0u8; 10]).is_none());
        // RIFF/WAVE magic but no chunks.
        assert!(pcm_view(b"RIFF\x00\x00\x00\x00WAVE").is_none());
    }

    #[test]
    #[cfg(feature = "native-encode")]
    fn opus_duration_matches_the_ogg_parsers_answer() {
        // The manual page-granule scan must agree with the `ogg` crate's
        // packet reader (±1 sample) on real encoder output — the resume
        // path times store segments by it.
        use super::super::encode::Encoder as _;
        use super::super::opus_native::tests as on;
        let wav_bytes = on::wav_bytes(&on::sine(16_000, 0.75, 440.0), 16_000);
        let opus = crate::opus_native::NativeOpusEncoder::new()
            .encode(&wav_bytes)
            .unwrap();
        let manual = opus_duration_seconds(&opus);
        assert!(
            (manual - 0.75).abs() < 0.05,
            "manual scan said {manual}s for 0.75s of audio"
        );
    }

    #[test]
    fn opus_duration_of_garbage_is_zero() {
        assert_eq!(opus_duration_seconds(&[]), 0.0);
        assert_eq!(opus_duration_seconds(b"not ogg at all"), 0.0);
        assert_eq!(opus_duration_seconds(b"OggS"), 0.0);
    }
}
