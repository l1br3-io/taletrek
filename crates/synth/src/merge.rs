//! Whole-book audio merge: a `.taletrek` bundle's segments remuxed into ONE
//! gapless OGG Opus stream (`.opus`). Feature `native-encode` (shares its
//! `ogg` dep); no decode, no re-encode — packet payloads are copied verbatim,
//! so merge is I/O-bound and lossless.
//!
//! # Remux shape (RFC 7845)
//!
//! One `OpusHead` (segment 0's, verbatim — its preskip governs the output
//! timeline), one `OpusTags` (vendor + `TITLE`/`ARTIST` from the manifest),
//! then every segment's audio packets in reading order, and a single EOS on
//! the final packet. Granule positions are made continuous: segment 0 keeps
//! its own granules, each later packet advances by its per-segment delta.
//!
//! /** GOTCHA */ OGG stores granules per PAGE, not per packet — every packet
//! of a page reports that page's absgp, so per-packet deltas are exact only
//! at page boundaries. The running-granule scheme below preserves every
//! page-boundary delta (hence exact total duration) while mid-page packets
//! share positions, which is all the container ever knew anyway.
//!
//! Reading order = chapters → paragraphs → `cache_key(voice, paragraph)`,
//! deduplicated first-occurrence-wins — the same rule the bundle writer
//! applies, so identical paragraphs collapse to one segment. Peak memory is
//! one segment: each is read via [`crate::read_audio_segment`] on demand.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Cursor, Write};
use std::path::Path;

use ogg::{PacketReader, PacketWriteEndInfo, PacketWriter};

use crate::bundle::audio::AudioCodec;
use crate::bundle::io::{read_audio_segment, read_book_metadata};
use crate::bundle::manifest::Manifest;
use crate::bundle::text::ChapterText;
use crate::cache_key::cache_key;
use crate::synth::SynthError;

/// OGG stream serial for the merged output. Fixed: the output is a
/// single-stream file, so per-file uniqueness is trivially satisfied.
const SERIAL: u32 = 0x5412_0002;

/// Vendor string stamped into the merged `OpusTags`.
const VENDOR: &str = "taletrek";

fn err(reason: impl Into<String>) -> SynthError {
    SynthError::Merge {
        reason: reason.into(),
    }
}

/// Merge every audio segment of the `.taletrek` bundle at `bundle_path`,
/// in reading order, into one gapless OGG Opus file at `dest_path`.
/// Returns the number of distinct segments merged (the reading-order walk,
/// post-dedup) — hosts surface it as progress proof, tests as a sanity count.
///
/// `TITLE` (and `ARTIST`, when the manifest knows the author) are stamped
/// into the `OpusTags` so external players label the file. Fails with
/// [`SynthError::Merge`] for text-only bundles, non-Opus codecs, missing
/// segments, and malformed/truncated segment payloads.
pub fn merge_bundle_audio(bundle_path: &Path, dest_path: &Path) -> Result<u32, SynthError> {
    let (manifest, chapters) =
        read_book_metadata(bundle_path).map_err(|e| err(format!("read bundle: {e}")))?;
    if !manifest.audio.present {
        return Err(err("bundle is text-only (no audio to merge)"));
    }
    if manifest.audio.codec != AudioCodec::Opus {
        return Err(err(format!(
            "codec `{}` cannot be merged (only Opus)",
            manifest.audio.codec.ext()
        )));
    }
    let keys = reading_order_keys(&manifest, &chapters);
    if keys.is_empty() {
        return Err(err("reading order resolves to zero segments"));
    }

    let out = File::create(dest_path).map_err(|e| err(format!("create output file: {e}")))?;
    let mut wtr = PacketWriter::new(BufWriter::new(out));

    let mut head_written = false;
    // Last audio packet seen, deferred so the true final packet carries EOS.
    let mut held: Option<(Vec<u8>, u64)> = None;
    // Output-timeline granule of the last written/queued audio packet.
    let mut out_granule: Option<u64> = None;

    for key in &keys {
        let seg = read_audio_segment(bundle_path, key)
            .map_err(|e| err(format!("read segment: {e}")))?
            .ok_or_else(|| err(format!("segment `{key}` missing from the bundle")))?;
        let (head, preskip, packets) = demux_segment(&seg.bytes)?;

        if !head_written {
            wtr.write_packet(head, SERIAL, PacketWriteEndInfo::EndPage, 0)
                .map_err(|e| err(format!("write OpusHead: {e}")))?;
            let tags = opus_tags(&manifest.book.title, manifest.book.author.as_deref());
            wtr.write_packet(tags, SERIAL, PacketWriteEndInfo::NormalPacket, 0)
                .map_err(|e| err(format!("write OpusTags: {e}")))?;
            head_written = true;
        }

        let mut in_prev: Option<u64> = None;
        for (data, gp) in packets {
            // GOTCHA: OGG granules are per PAGE — packets sharing a page
            // share an absgp, so within-segment deltas are exact only at
            // page boundaries. Summing boundary deltas preserves the exact
            // total duration; mid-page packets share positions, which is
            // all the source container ever knew.
            let rel = match in_prev {
                None => gp
                    .checked_sub(u64::from(preskip))
                    .ok_or_else(|| err("first audio packet granule is below preskip"))?,
                Some(prev) => gp
                    .checked_sub(prev)
                    .ok_or_else(|| err("segment granule positions decrease"))?,
            };
            in_prev = Some(gp);
            let out_gr = match out_granule {
                // First audio packet overall: segment 0's granule, verbatim.
                None => gp,
                Some(prev_out) => prev_out
                    .checked_add(rel)
                    .ok_or_else(|| err("merged granule position overflows"))?,
            };
            out_granule = Some(out_gr);
            if let Some((prev_data, prev_gr)) = held.take() {
                wtr.write_packet(prev_data, SERIAL, PacketWriteEndInfo::NormalPacket, prev_gr)
                    .map_err(|e| err(format!("write packet: {e}")))?;
            }
            held = Some((data, out_gr));
        }
    }

    let (data, gr) = held.ok_or_else(|| err("segments carry no audio packets"))?;
    wtr.write_packet(data, SERIAL, PacketWriteEndInfo::EndStream, gr)
        .map_err(|e| err(format!("write final packet: {e}")))?;
    wtr.into_inner()
        .flush()
        .map_err(|e| err(format!("flush output: {e}")))?;
    Ok(u32::try_from(keys.len()).unwrap_or(u32::MAX))
}

/// One demuxed segment: `(OpusHead bytes, preskip, (payload, page-granule) audio packets)`.
type DemuxedSegment = (Vec<u8>, u16, Vec<(Vec<u8>, u64)>);

/// Demux one segment's OGG into `(OpusHead bytes, preskip, audio packets)`.
/// Headers are stripped; the payload must be a complete, well-formed stream.
fn demux_segment(bytes: &[u8]) -> Result<DemuxedSegment, SynthError> {
    let mut rdr = PacketReader::new(Cursor::new(bytes));
    let mut head: Option<Vec<u8>> = None;
    let mut preskip = 0u16;
    let mut packets = Vec::new();
    let mut last_was_eos = false;
    while let Some(pkt) = rdr
        .read_packet()
        .map_err(|e| err(format!("demux segment: {e}")))?
    {
        if head.is_none() {
            if !pkt.data.starts_with(b"OpusHead") || pkt.data.len() < 19 {
                return Err(err("segment does not start with a valid OpusHead"));
            }
            preskip = u16::from_le_bytes(pkt.data[10..12].try_into().unwrap());
            head = Some(pkt.data);
            continue;
        }
        if pkt.data.starts_with(b"OpusTags") {
            continue;
        }
        last_was_eos = pkt.last_in_stream();
        packets.push((pkt.data.clone(), pkt.absgp_page()));
    }
    let head = head.ok_or_else(|| err("segment carries no OpusHead"))?;
    if packets.is_empty() {
        return Err(err("segment carries no audio packets (truncated?)"));
    }
    // A complete segment ends on an EOS-flagged page; anything else means the
    // payload was cut short.
    if !last_was_eos {
        return Err(err("segment does not end with EOS (truncated?)"));
    }
    Ok((head, preskip, packets))
}

/// Reading-order segment keys with the writer's dedup rule.
fn reading_order_keys(manifest: &Manifest, chapters: &[ChapterText]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut keys = Vec::new();
    for chapter in chapters {
        for para in &chapter.paragraphs {
            let key = cache_key(&manifest.book.voice_id, para);
            if seen.insert(key.clone()) {
                keys.push(key);
            }
        }
    }
    keys
}

/// `OpusTags` with vendor + `TITLE`/`ARTIST` comments (RFC 7845 §5.2).
fn opus_tags(title: &str, artist: Option<&str>) -> Vec<u8> {
    fn comment(out: &mut Vec<u8>, field: &str, value: &str) {
        let pair = format!("{field}={value}");
        out.extend_from_slice(&(pair.len() as u32).to_le_bytes());
        out.extend_from_slice(pair.as_bytes());
    }
    let mut t = Vec::new();
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(VENDOR.len() as u32).to_le_bytes());
    t.extend_from_slice(VENDOR.as_bytes());
    t.extend_from_slice(&(1 + usize::from(artist.is_some()) as u32).to_le_bytes());
    comment(&mut t, "TITLE", title);
    if let Some(a) = artist {
        comment(&mut t, "ARTIST", a);
    }
    t
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;

    use ogg::PacketReader;
    use tempfile::TempDir;

    use super::*;
    use crate::bundle::audio::{AudioCodec, AudioSegment};
    use crate::bundle::manifest::{AudioMeta, BookMeta, Generator, ManifestKind};
    use crate::bundle::BookBundle;
    use crate::encode::Encoder;
    use crate::opus_native::tests as on;
    use crate::NORM_VERSION;
    use crate::{NativeOpusEncoder, SCHEMA_VERSION};

    const VOICE: &str = "en_US-lessac-medium";
    const RATE: u32 = 16_000;

    /// Encode `secs` of a sine at `freq` through the real native encoder —
    /// the exact bytes a produced bundle would carry in `audio/`.
    fn encoded_sine(freq: f64, secs: f64) -> Vec<u8> {
        NativeOpusEncoder::new()
            .encode(&on::wav_bytes(&on::sine(RATE, secs, freq), RATE))
            .unwrap()
    }

    /// A real Opus segment's header packet (OpusHead) for verbatim checks.
    fn opus_head_of(segment: &[u8]) -> Vec<u8> {
        let mut rdr = PacketReader::new(Cursor::new(segment));
        let pkt = rdr.read_packet().unwrap().expect("first packet");
        assert!(pkt.data.starts_with(b"OpusHead"));
        pkt.data
    }

    /// Audio-present bundle on disk from `(freq, secs)` segments; each test
    /// paragraph maps to one distinct segment (the repeated paragraph reuses
    /// its segment, exercising dedup). Returns (tempdir, bundle path, bytes
    /// per distinct segment in reading order).
    fn bundle_on_disk(
        freqs: &[f64],
        secs: f64,
        author: Option<&str>,
    ) -> (TempDir, PathBuf, Vec<Vec<u8>>) {
        let segments: Vec<Vec<u8>> = freqs.iter().map(|f| encoded_sine(*f, secs)).collect();
        let paragraphs: Vec<String> = freqs
            .iter()
            .enumerate()
            .map(|(i, _)| format!("Paragraph number {i} of the fixture book."))
            .collect();
        // Reading order repeats segment 0 at the end → dedup must collapse it.
        let mid = paragraphs.len().div_ceil(2);
        let mut chapter_two: Vec<String> = paragraphs[mid..].to_vec();
        chapter_two.push(paragraphs[0].clone());
        let chapters = vec![
            ChapterText::new("bk_merge", 0, "Chapter One", paragraphs[..mid].to_vec()),
            ChapterText::new("bk_merge", 1, "Chapter Two", chapter_two),
        ];
        let keys: Vec<String> = paragraphs.iter().map(|p| cache_key(VOICE, p)).collect();
        let mut audio = HashMap::new();
        for (key, bytes) in keys.iter().zip(&segments) {
            audio.insert(
                key.clone(),
                AudioSegment {
                    key: key.clone(),
                    codec: AudioCodec::Opus,
                    bytes: bytes.clone(),
                },
            );
        }
        let bundle = BookBundle {
            manifest: Manifest {
                schema_version: SCHEMA_VERSION,
                kind: ManifestKind::Book,
                book: BookMeta {
                    id: "bk_merge".into(),
                    title: "Merge Fixture".into(),
                    author: author.map(Into::into),
                    source_format: "txt".into(),
                    chapter_count: chapters.len() as u32,
                    voice_id: VOICE.into(),
                    created_at: 0,
                    updated_at: 0,
                    progress_fraction: None,
                },
                audio: AudioMeta {
                    present: true,
                    codec: AudioCodec::Opus,
                    norm_version: NORM_VERSION.parse().unwrap(),
                    segment_count: segments.len() as u32,
                },
                generator: Generator {
                    app: "taletrek-merge-test".into(),
                    version: "0.0.0".into(),
                },
            },
            chapters,
            audio,
        };
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bundle.taletrek");
        let mut buf = Cursor::new(Vec::new());
        crate::write_book_bundle(&bundle, &mut buf).unwrap();
        fs::write(&path, buf.into_inner()).unwrap();
        (tmp, path, segments)
    }

    /// Demux the merged output into (opus_head, opus_tags, audio payloads).
    fn demux(bytes: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<Vec<u8>>) {
        let mut rdr = PacketReader::new(Cursor::new(bytes));
        let mut head = None;
        let mut tags = None;
        let mut audio = Vec::new();
        while let Some(pkt) = rdr.read_packet().expect("demux merged") {
            if head.is_none() {
                assert!(pkt.data.starts_with(b"OpusHead"), "first packet");
                head = Some(pkt.data);
            } else if tags.is_none() && pkt.data.starts_with(b"OpusTags") {
                tags = Some(pkt.data);
            } else {
                audio.push(pkt.data);
            }
        }
        (head.unwrap(), tags.expect("OpusTags"), audio)
    }

    /// Page-level scan: (BOS page count, EOS page count) via `OggS` + flags.
    fn stream_flags(bytes: &[u8]) -> (usize, usize) {
        let mut bos = 0;
        let mut eos = 0;
        let mut i = 0;
        while let Some(pos) = bytes[i..].windows(4).position(|w| w == b"OggS") {
            let at = i + pos;
            if bytes[at + 5] & 0x02 != 0 {
                bos += 1;
            }
            if bytes[at + 5] & 0x04 != 0 {
                eos += 1;
            }
            i = at + 4;
        }
        (bos, eos)
    }

    /// Pull `FIELD=value` comments out of an OpusTags packet.
    fn tags_comments(tags: &[u8]) -> Vec<String> {
        let mut at = 8;
        let vlen = u32::from_le_bytes(tags[at..at + 4].try_into().unwrap()) as usize;
        at += 4 + vlen;
        let count = u32::from_le_bytes(tags[at..at + 4].try_into().unwrap()) as usize;
        at += 4;
        (0..count)
            .map(|_| {
                let len = u32::from_le_bytes(tags[at..at + 4].try_into().unwrap()) as usize;
                at += 4;
                let s = String::from_utf8(tags[at..at + len].to_vec()).unwrap();
                at += len;
                s
            })
            .collect()
    }

    /// Container duration (samples at 48 kHz) of an Opus stream: last page
    /// granule − preskip.
    fn container_duration(bytes: &[u8]) -> u64 {
        let mut rdr = PacketReader::new(Cursor::new(bytes));
        let head = rdr.read_packet().unwrap().expect("head");
        let preskip = u16::from_le_bytes(head.data[10..12].try_into().unwrap());
        let mut last = 0u64;
        while let Some(pkt) = rdr.read_packet().unwrap() {
            last = last.max(pkt.absgp_page());
        }
        last - u64::from(preskip)
    }

    #[test]
    fn merge_is_one_stream_with_headers_once_and_payloads_in_order() {
        let segments = vec![440.0, 620.0, 830.0];
        let (_tmp, path, src) = bundle_on_disk(&segments, 0.4, Some("Fixture Author"));
        merge_bundle_audio(&path, &tmp_out(&path)).unwrap();
        let merged = fs::read(tmp_out(&path)).unwrap();

        // Exactly one BOS page (first) and one EOS page (last).
        let (bos, eos) = stream_flags(&merged);
        assert_eq!(bos, 1, "exactly one BOS page");
        assert_eq!(eos, 1, "exactly one EOS page");

        // One OpusHead, verbatim from segment 0; one OpusTags with metadata.
        let (head, tags, audio) = demux(&merged);
        assert_eq!(head, opus_head_of(&src[0]), "OpusHead verbatim from seg 0");
        let comments = tags_comments(&tags);
        assert!(
            comments.contains(&"TITLE=Merge Fixture".to_string()),
            "{comments:?}"
        );
        assert!(
            comments.contains(&"ARTIST=Fixture Author".to_string()),
            "{comments:?}"
        );

        // Payloads byte-identical, reading order, dedup collapsed the repeat:
        // segment 0 appears once, then 1, then 2.
        let mut expected = Vec::new();
        for bytes in [&src[0], &src[1], &src[2]] {
            expected.extend(source_audio_payloads(bytes));
        }
        assert_eq!(audio, expected);
    }

    #[test]
    fn merged_container_duration_is_the_exact_sum_of_segment_durations() {
        let (_tmp, path, src) = bundle_on_disk(&[440.0, 620.0], 0.75, None);
        merge_bundle_audio(&path, &tmp_out(&path)).unwrap();
        let merged = fs::read(tmp_out(&path)).unwrap();

        let sum: u64 = src.iter().map(|s| container_duration(s)).sum();
        let got = container_duration(&merged);
        assert_eq!(got, sum, "granule math must be exact (boundary deltas)");
    }

    #[test]
    fn merged_decoded_duration_matches_the_sum_within_boundary_tolerance() {
        let (_tmp, path, _src) = bundle_on_disk(&[440.0, 620.0, 830.0], 0.6, None);
        merge_bundle_audio(&path, &tmp_out(&path)).unwrap();
        let merged = fs::read(tmp_out(&path)).unwrap();

        let dec = on::decode_ogg(&merged, RATE);
        let dur = dec.len() as f64 / f64::from(RATE);
        // Three segments → two boundaries → ≤ 50 ms each.
        assert!(
            (dur - 1.8).abs() <= 0.1,
            "decoded {dur:.3} s, expected 1.8 ± boundary tolerance"
        );
    }

    #[test]
    fn text_only_bundle_is_a_typed_error() {
        let (tmp, path, _src) = bundle_on_disk(&[440.0], 0.2, None);
        // Rewrite the bundle as text-only: present=false, no audio entries.
        let (manifest, chapters) = crate::read_book_metadata(&path).unwrap();
        let text_only = BookBundle {
            manifest: Manifest {
                audio: AudioMeta {
                    present: false,
                    ..manifest.audio
                },
                ..manifest
            },
            chapters,
            audio: HashMap::new(),
        };
        let only = tmp.path().join("text-only.taletrek");
        let mut buf = Cursor::new(Vec::new());
        crate::write_book_bundle(&text_only, &mut buf).unwrap();
        fs::write(&only, buf.into_inner()).unwrap();

        let err = merge_bundle_audio(&only, &tmp.path().join("out.opus")).unwrap_err();
        assert!(matches!(err, SynthError::Merge { .. }), "got: {err:?}");
    }

    #[test]
    fn truncated_segment_is_a_typed_error_not_a_panic() {
        let (tmp, path, src) = bundle_on_disk(&[440.0, 620.0], 0.4, None);
        // Corrupt one segment in the archive: truncate its payload to half.
        let mut bundle = crate::read_book_bundle(&fs::read(&path).unwrap()).unwrap();
        let key = bundle.audio.keys().next().expect("a segment key").clone();
        bundle.audio.get_mut(&key).unwrap().bytes = src[0][..src[0].len() / 2].to_vec();
        let bad = tmp_alt(&path);
        let mut buf = Cursor::new(Vec::new());
        crate::write_book_bundle(&bundle, &mut buf).unwrap();
        fs::write(&bad, buf.into_inner()).unwrap();

        let err = merge_bundle_audio(&bad, &tmp.path().join("out.opus")).unwrap_err();
        assert!(matches!(err, SynthError::Merge { .. }), "got: {err:?}");
    }

    #[test]
    fn missing_segment_for_a_declared_paragraph_is_a_typed_error() {
        let (tmp, path, _src) = bundle_on_disk(&[440.0], 0.2, None);
        // Drop one audio entry while the manifest still declares its segment.
        let mut bundle = crate::read_book_bundle(&fs::read(&path).unwrap()).unwrap();
        let victim = bundle.audio.keys().next().expect("key").clone();
        bundle.audio.remove(&victim);
        let bad = tmp.path().join("missing.taletrek");
        let mut buf = Cursor::new(Vec::new());
        crate::write_book_bundle(&bundle, &mut buf).unwrap();
        fs::write(&bad, buf.into_inner()).unwrap();

        let err = merge_bundle_audio(&bad, &tmp.path().join("out.opus")).unwrap_err();
        assert!(matches!(err, SynthError::Merge { .. }), "got: {err:?}");
    }

    #[test]
    fn no_artist_in_manifest_means_no_artists_comment() {
        let (_tmp, path, _src) = bundle_on_disk(&[440.0], 0.2, None);
        merge_bundle_audio(&path, &tmp_out(&path)).unwrap();
        let merged = fs::read(tmp_out(&path)).unwrap();
        let (_, tags, _) = demux(&merged);
        let comments = tags_comments(&tags);
        assert_eq!(comments, vec!["TITLE=Merge Fixture".to_string()]);
        // Vendor survives the remux.
        assert!(tags[8..].starts_with(&(VENDOR.len() as u32).to_le_bytes()));
    }

    // ---- helpers ----

    fn tmp_out(bundle: &Path) -> PathBuf {
        bundle.parent().unwrap().join("merged.opus")
    }

    fn tmp_alt(bundle: &Path) -> PathBuf {
        bundle.parent().unwrap().join("alt.taletrek")
    }

    /// A source segment's audio payloads (skip OpusHead + OpusTags).
    fn source_audio_payloads(segment: &[u8]) -> Vec<Vec<u8>> {
        let mut rdr = PacketReader::new(Cursor::new(segment));
        let mut out = Vec::new();
        while let Some(pkt) = rdr.read_packet().expect("demux source") {
            if pkt.data.starts_with(b"OpusHead") || pkt.data.starts_with(b"OpusTags") {
                continue;
            }
            out.push(pkt.data);
        }
        out
    }
}
