//! Manifest stamping + input-refusal: the host-shared core of `synth` /
//! `resynth` that runs the parallel synth engine, replaces the audio map, and
//! stamps the manifest as a full bundle.
//!
//! # The single stamping-path invariant
//!
//! Every host — today the desktop CLI (`taletrek-desktop`), soon the desktop
//! GUI and mobile apps — stamps `generator.app` through this one module. The
//! producer string is a **parameter** ([`synth_and_stamp`] /
//! [`resynth_and_stamp`] / [`synth_and_stamp_streaming`] take
//! `generator_app: &str`); it is never hardcoded here. A new host that
//! stamps a different `generator.app` without routing through this module would
//! re-introduce the "bundle format drift, 3rd producer" risk this effort's plan
//! calls out — the mitigation is keeping one code path. The module has two
//! entry-point *shapes* — in-memory ([`synth_and_stamp`], segments accumulate
//! into `bundle.audio`) and streaming ([`synth_and_stamp_streaming`], segments
//! flow through a sink into an open [`taletrek_synth::BundleWriter`]) — but
//! both stamp through the same `stamp_manifest_fields`: one stamper, two
//! delivery shapes, byte-identical manifests.
//!
//! # Purity
//!
//! This module is pure: no file I/O, no network. The desktop's
//! `write_book_bundle_file` wraps the lib's in-memory writer with a buffered
//! file write; future hosts wrap their own stores. The streaming entry point
//! is sink-agnostic (`W: Write + Seek`) — it writes whatever sink the caller's
//! `BundleWriter` was opened on, never a path of its own.
//! Accordingly [`StampError`] has **no** `WriteFile` variant — file errors stay
//! host-side (the streaming path surfaces sink failures as
//! [`StampError::Bundle`], the typed zip/write error from the writer). Both
//! stamp functions write the effective synth voice into
//! `manifest.book.voiceId` so the stamped manifest and the content-addressed
//! cache keys always agree (the format's implicit paragraph→audio mapping is
//! computed from the manifest voice — docs/bundle-format.md).

use std::io::{Seek, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use thiserror::Error;

use taletrek_synth::bundle::manifest::{AudioMeta, Generator, Manifest};
use taletrek_synth::synth::PiperRunner;
use taletrek_synth::{AudioCodec, BookBundle, BundleError, BundleWriter, Encoder, NORM_VERSION};

use crate::{
    synth_all_paragraphs, synth_paragraphs_into, ProgressSink, SegmentSink, SynthJobError,
};

/// Error returned when `synth` is pointed at a bundle that already carries
/// audio. `synth` only accepts text-only input; the user wants `resynth` to
/// re-voice an existing bundle. Carries the existing `voiceId` so the message
/// can hint at what's already there.
///
/// `input` is whatever display string the caller supplied (an input path on the
/// desktop CLI, whatever id a future host uses) so the message stays useful in
/// every host.
#[derive(Debug, Error)]
#[error(
    "input bundle `{input}` already contains audio (voice `{voice}`); use resynth to re-voice it"
)]
pub struct FullInputError {
    /// Caller-supplied display string identifying the offending bundle
    /// (e.g. the input path on the desktop CLI).
    pub input: String,
    /// The voice the existing audio was synth'd under (`book.voiceId`).
    pub voice: String,
}

/// All the ways a synth + stamp run can fail. File-write errors are
/// intentionally absent: this module is pure and never touches a file — the
/// host writes the bundle ([`StampError`] has no `WriteFile` variant).
///
/// `Bundle` is included so a host can `?`-lift a serialization step uniformly
/// into this error type; `synth_and_stamp` / `resynth_and_stamp` do not produce
/// it today (the in-memory stamp is infallible).
#[derive(Debug, Error)]
pub enum StampError {
    /// Parallel synth failed (first-paragraph abort, pool build, etc.). Lifted
    /// from [`SynthJobError`].
    #[error(transparent)]
    Synth(#[from] SynthJobError),

    /// Serializing the bundle (ZIP + JSON) failed. Lifted from the lib.
    #[error(transparent)]
    Bundle(#[from] BundleError),
}

/// Refuse an already-full bundle for `synth`. `synth` only accepts text-only
/// input (`audio.present == false`); re-voicing an existing bundle is what
/// `resynth` is for. The error carries the caller-supplied `label` (input path
/// on the desktop CLI, whatever id a future host uses) + the existing
/// `book.voiceId` so
/// the message can point the user at `resynth`.
pub fn refuse_full_input(bundle: &BookBundle, label: &str) -> Result<(), FullInputError> {
    if bundle.manifest.audio.present {
        return Err(FullInputError {
            input: label.to_string(),
            voice: bundle.manifest.book.voice_id.clone(),
        });
    }
    Ok(())
}

/// Stamp a manifest's audio descriptor + generator for a completed synth run:
/// audio present, the encoder's codec, the current norm version, the given
/// (dedup'd) segment count, and the `generator_app` the caller passed at the
/// running crate version. This is the one stamping implementation both entry
/// points route through — the single-stamping-path invariant.
/// Stamp `manifest` to reflect a completed synth run: audio present, the
/// encoder's codec, the current norm version, the dedup'd segment count, and
/// the caller's `generator.app` at the running crate version. Shared by the
/// in-memory, streaming, and progressive-seal stamping paths — the ONE place
/// a full manifest gets its audio block (the single-stamping-path invariant).
pub(crate) fn stamp_manifest_fields(
    manifest: &mut Manifest,
    codec: AudioCodec,
    segment_count: u32,
    generator_app: &str,
) {
    // Dedup collapses identical paragraphs into one segment, so `segment_count`
    // is the stored entry count (not the paragraph count). Matches how the SPA's
    // audio cache behaves and what `read_book_bundle` reconstructs on import.
    manifest.audio = AudioMeta {
        present: true,
        codec,
        norm_version: NORM_VERSION
            .parse()
            .expect("NORM_VERSION is a decimal u32 (crate invariant)"),
        segment_count,
    };
    manifest.generator = Generator {
        app: generator_app.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
}

/// Stamp `bundle`'s manifest to reflect a completed synth run: audio present,
/// the encoder's codec, the current norm version, the segment count, and the
/// `generator.app` passed by the caller at the running crate version. The
/// book's `voice_id` is preserved — `synth` keeps the input value; `resynth`
/// rewrites it before calling [`synth_and_stamp`] so keys and manifest agree.
fn stamp_full_manifest(bundle: &mut BookBundle, codec: AudioCodec, generator_app: &str) {
    let segment_count = u32::try_from(bundle.audio.len()).unwrap_or(u32::MAX);
    stamp_manifest_fields(&mut bundle.manifest, codec, segment_count, generator_app);
}

/// Run the parallel synth engine over every paragraph in `bundle`, fill its
/// `audio` map with the resulting segments, and stamp the manifest as a full
/// bundle. Pure: no file I/O, no network.
///
/// `voice_id` namespaces the cache keys AND is written to
/// `manifest.book.voiceId` — the two must agree because the format's
/// paragraph→audio mapping is implicit: importers compute segment keys from
/// the manifest's `book.voiceId` (docs/bundle-format.md § audio). A bundle
/// whose manifest names voice A while its segments are keyed under voice B
/// is unplayable on import (the lookups miss). `resynth_and_stamp` therefore
/// only needs to validate the new voice; this function performs the rewrite
/// for both entry points.
///
/// `make_runner` is called once per work chunk (at most `jobs` times per run)
/// to produce a chunk-owned runner (see [`synth_all_paragraphs`]). The encoder
/// is shared by `&E` across all tasks.
///
/// `generator_app` is stamped into the manifest's `generator.app`; it is a
/// parameter (not a constant here) so every host routes its distinct producer
/// string through this one path. The version is the running
/// crate version (`CARGO_PKG_VERSION`).
///
/// Aborts on the first paragraph error (lifted as [`StampError::Synth`]).
///
/// `progress`, when `Some`, is forwarded to the synth engine for per-paragraph
/// `synth [n/total] pct%` lines. `None` is silent.
#[allow(clippy::too_many_arguments)] // 8 args: the `generator_app` parameter is the host-portability seam this module exists for (T3); grouping would hide the API the host wrappers mirror.
pub fn synth_and_stamp<R, E, F>(
    bundle: &mut BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    generator_app: &str,
    progress: Option<&dyn ProgressSink>,
) -> Result<(), StampError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    // Rewrite the manifest's voice FIRST so the stamped manifest and the
    // content-addressed cache keys agree — see the function docs. This is the
    // format contract, not a cosmetic choice.
    bundle.manifest.book.voice_id = voice_id.to_string();
    let segments = synth_all_paragraphs(
        bundle,
        voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        progress,
    )?;
    // Replace (don't extend) so resynth's stale audio under the old voice is
    // discarded — synth starts from an empty audio map.
    bundle.audio = segments;
    stamp_full_manifest(bundle, encoder.codec(), generator_app);
    Ok(())
}

/// The streaming flavor of [`synth_and_stamp`]: run the sink synth engine over
/// every paragraph in `bundle`, delivering each finished segment straight into
/// `writer` (an open [`BundleWriter`] on the run's final resting sink —
/// typically a same-dir temp file), then stamp the manifest with the exact
/// same fields the in-memory path produces and `finish` the archive. Returns
/// the flushed sink plus the stamped (dedup'd) segment count.
///
/// Manifest discipline is identical to [`synth_and_stamp`]: `book.voiceId` is
/// rewritten to `voice_id` **before** synth (keys and manifest must agree —
/// the format contract), and the stamped fields route through the same
/// `stamp_manifest_fields` the in-memory path uses (the single-stamping-path
/// invariant holds: one module, two entry points). `bundle.audio` is ignored
/// and never populated — nothing accumulates; peak memory is one segment.
///
/// On success `bundle.manifest` is stamped in place (same as the in-memory
/// path) and the returned `W` holds the complete, flushed `.taletrek` bytes —
/// the caller performs the final atomic rename. On error the writer and its
/// sink are consumed and closed (the archive is left unfinished and therefore
/// unusable) — the caller must discard the backing temp file; a partial book
/// is never a book.
///
/// `make_runner`, `encoder`, `jobs`, and `progress` behave exactly as in
/// [`synth_and_stamp`]. Aborts on the first paragraph *or write* error
/// (lifted as [`StampError::Synth`] / [`StampError::Bundle`]).
#[allow(clippy::too_many_arguments)] // mirrors synth_and_stamp + the writer param; the sibling's rationale applies.
pub fn synth_and_stamp_streaming<R, E, F, W>(
    bundle: &mut BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    generator_app: &str,
    progress: Option<&dyn ProgressSink>,
    writer: BundleWriter<W>,
) -> Result<(W, u32), StampError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
    W: Write + Seek + Send + 'static,
{
    // Rewrite the manifest's voice FIRST so the stamped manifest and the
    // content-addressed cache keys agree — same contract as the in-memory
    // path, applied before the sink engine starts delivering.
    bundle.manifest.book.voice_id = voice_id.to_string();

    let writer = Arc::new(Mutex::new(writer));
    let sink_writer = writer.clone();
    let sink = SegmentSink::new(move |key, seg| {
        sink_writer
            .lock()
            .map_err(|_| BundleError::Io(std::io::Error::other("bundle writer mutex poisoned")))?
            .add_segment(&key, &seg)?;
        Ok(())
    });

    let synth = synth_paragraphs_into(
        bundle,
        voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        progress,
        &sink,
    );
    drop(sink);

    // On a synth/write error the writer is dropped with the Arc — its sink
    // closes, the archive stays unfinished, and the caller discards the file.
    synth?;

    let writer = match Arc::try_unwrap(writer) {
        Ok(mutex) => mutex
            .into_inner()
            .map_err(|_| BundleError::Io(std::io::Error::other("bundle writer mutex poisoned")))?,
        Err(_) => unreachable!("streaming sink dropped after the run"),
    };
    let segment_count = writer.segment_count();
    stamp_manifest_fields(
        &mut bundle.manifest,
        encoder.codec(),
        segment_count,
        generator_app,
    );
    let sink = writer.finish(bundle.manifest.clone())?;
    Ok((sink, segment_count))
}

/// Re-voice a bundle: rewrite `book.voiceId` to `new_voice_id`, then re-synth
/// every paragraph under the new voice. The audio map is **replaced**
/// (delegates to [`synth_and_stamp`]), so stale segments keyed under the
/// previous voice are discarded — not merged.
///
/// Unlike `synth`, this accepts **both** text-only and full input: re-voicing
/// a full bundle is the whole point. The caller must not run [`refuse_full_input`].
///
/// `generator_app` is stamped into `generator.app` (parameter — see
/// [`synth_and_stamp`]). Aborts on the first paragraph error (lifted as
/// [`StampError::Synth`]), matching `synth`'s v1 semantics.
///
/// `progress` is forwarded to the synth engine for per-paragraph progress.
#[allow(clippy::too_many_arguments)] // mirrors synth_and_stamp's signature so the host wrappers forward 1:1; `generator_app` is the host-portability seam (T3).
pub fn resynth_and_stamp<R, E, F>(
    bundle: &mut BookBundle,
    new_voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    generator_app: &str,
    progress: Option<&dyn ProgressSink>,
) -> Result<(), StampError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    // Rewrite up front for symmetry with the (now-rewriting) synth_and_stamp;
    // the inner call rewrites to the same value, keeping one code path.
    bundle.manifest.book.voice_id = new_voice_id.to_string();
    synth_and_stamp(
        bundle,
        new_voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        generator_app,
        progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::path::Path;

    use taletrek_synth::synth::SynthError;
    use taletrek_synth::{
        cache_key, read_book_bundle, write_book_bundle, AudioCodec, AudioMeta, AudioSegment,
        BookMeta, ChapterText, Generator, Manifest, ManifestKind, WavPassthrough,
    };

    /// Producer string stamped by these tests. Asserted back as `generator.app`
    /// — the point is that the worker stamps whatever string the caller passes
    /// (not a host-specific constant).
    const TEST_APP: &str = "taletrek-worker-test";

    /// Canonical mono 16-bit 16 kHz WAV with `pcm` as its data payload — the
    /// shape Piper emits on stdout. Duplicated from `synth_job.rs` so each
    /// module's tests stay self-contained.
    fn canonical_wav(pcm: &[u8]) -> Vec<u8> {
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

    /// In-process runner: returns a fixed canonical WAV regardless of input.
    struct StubRunner;

    impl PiperRunner for StubRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    /// Build a minimal bundle with the given audio-present flag + voice id.
    /// Defaults to a text-only bundle under the given voice.
    fn bundle(voice_id: &str, present: bool, chapters: Vec<ChapterText>) -> BookBundle {
        let chapter_count = u32::try_from(chapters.len()).unwrap();
        let segment_count = if present { u32::MAX } else { 0 };
        BookBundle {
            manifest: Manifest {
                schema_version: 1,
                kind: ManifestKind::Book,
                book: BookMeta {
                    id: "bk_test".into(),
                    title: "Test Book".into(),
                    author: None,
                    source_format: "txt".into(),
                    chapter_count,
                    voice_id: voice_id.into(),
                    created_at: 0,
                    updated_at: 0,
                    progress_fraction: None,
                },
                audio: AudioMeta {
                    present,
                    codec: AudioCodec::Opus,
                    norm_version: NORM_VERSION.parse().unwrap(),
                    segment_count,
                },
                generator: Generator {
                    app: "taletrek-spa".into(),
                    version: "0.0.0".into(),
                },
            },
            chapters,
            audio: HashMap::new(),
        }
    }

    fn text_only_bundle(voice_id: &str, chapters: Vec<ChapterText>) -> BookBundle {
        bundle(voice_id, false, chapters)
    }

    // ---- refuse_full_input ----

    #[test]
    fn refuse_full_input_accepts_text_only() {
        let b = text_only_bundle("v", vec![]);
        assert!(refuse_full_input(&b, "x.taletrek").is_ok());
    }

    #[test]
    fn refuse_full_input_rejects_full_bundle_with_existing_voice() {
        let b = bundle("en_US-lessac-medium", true, vec![]);
        let err = refuse_full_input(&b, "full.taletrek").unwrap_err();
        assert_eq!(err.input, "full.taletrek");
        assert_eq!(err.voice, "en_US-lessac-medium");
        assert!(
            err.to_string().contains("resynth"),
            "error must point at resynth: {err}"
        );
    }

    // ---- synth_and_stamp + stamp_full_manifest ----

    #[test]
    fn synth_and_stamp_round_trips_with_correct_manifest() {
        let mut b = text_only_bundle(
            "en_US-hfc_female-medium",
            vec![
                ChapterText::new(
                    "bk_test",
                    0,
                    "Ch",
                    vec!["Hello world.".into(), "Second paragraph.".into()],
                ),
                ChapterText::new("bk_test", 1, "Two", vec!["Across chapters.".into()]),
            ],
        );
        let voice = "en_US-hfc_female-medium";

        synth_and_stamp(
            &mut b,
            voice,
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            TEST_APP,
            None,
        )
        .expect("synth + stamp should succeed with stub runner");

        // Round-trip through the lib's writer/reader so the manifest we stamp
        // is exactly what a consumer will see on import.
        let mut buf = Cursor::new(Vec::new());
        write_book_bundle(&b, &mut buf).expect("write should succeed");
        let back = read_book_bundle(&buf.into_inner()).expect("read should succeed");

        // Audio descriptor flipped to "full" with the encoder's codec (WAV via
        // WavPassthrough), current norm version, and the dedup'd segment count.
        assert!(back.manifest.audio.present, "audio.present must be true");
        assert_eq!(back.manifest.audio.codec, AudioCodec::Wav);
        assert_eq!(
            back.manifest.audio.norm_version,
            NORM_VERSION.parse::<u32>().unwrap()
        );
        assert_eq!(back.manifest.audio.segment_count, 3);

        // Generator stamped as the caller-supplied app at the running crate
        // version — never a host-specific constant baked into the worker.
        assert_eq!(back.manifest.generator.app, TEST_APP);
        assert_eq!(back.manifest.generator.version, env!("CARGO_PKG_VERSION"));

        // book.voiceId names the voice the segments are keyed under (the
        // input fixture already used it here, so this is a no-op rewrite).
        assert_eq!(back.manifest.book.voice_id, voice);

        // Every distinct paragraph produced the segment keyed by cache_key, and
        // the audio map survived the round-trip intact.
        let expected_keys = [
            cache_key(voice, "Hello world."),
            cache_key(voice, "Second paragraph."),
            cache_key(voice, "Across chapters."),
        ];
        for k in &expected_keys {
            assert!(back.audio.contains_key(k), "missing audio for {k}");
        }
        assert_eq!(back.audio.len(), expected_keys.len());
    }

    #[test]
    fn synth_and_stamp_rewrites_manifest_voice_when_synth_voice_differs() {
        // The format contract: importers compute segment keys from
        // `book.voiceId`, so the manifest must name the voice the segments are
        // actually keyed under — even when it differs from the input's voice.
        // (Preserving a stale voiceId would make the bundle unplayable on
        // import; the lookups would all miss.)
        let mut b = text_only_bundle(
            "en_US-lessac-medium",
            vec![ChapterText::new("bk_test", 0, "Ch", vec!["Hi.".into()])],
        );

        synth_and_stamp(
            &mut b,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            TEST_APP,
            None,
        )
        .expect("stub runner succeeds");

        assert_eq!(
            b.manifest.book.voice_id, "en_US-ryan-medium",
            "manifest must follow the synth voice (format contract)"
        );
        // Audio is keyed under the synth voice (ryan) — same voice the
        // manifest now names.
        assert!(b.audio.contains_key(&cache_key("en_US-ryan-medium", "Hi.")));
    }

    #[test]
    fn synth_and_stamp_segment_count_reflects_dedup() {
        // Two identical paragraphs collapse to one segment (content addressing);
        // segmentCount must be 1, not 2.
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["Repeat.".into(), "Repeat.".into()],
            )],
        );

        synth_and_stamp(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            TEST_APP,
            None,
        )
        .expect("stub runner succeeds");

        assert_eq!(b.manifest.audio.segment_count, 1);
        assert_eq!(b.audio.len(), 1);
    }

    #[test]
    fn synth_and_stamp_aborts_on_empty_paragraph() {
        // Delegates to synth_job's abort-on-first-error: an empty paragraph
        // surfaces as Synth(EmptyText), not a silent skip.
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["   \n   ".into()],
            )],
        );

        let err = synth_and_stamp(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            TEST_APP,
            None,
        )
        .expect_err("empty paragraph must error");
        assert!(matches!(err, StampError::Synth(_)));
    }

    // ---- synth_and_stamp_streaming (streaming stamp — streaming-synth) ----

    /// Field-for-field manifest equality (the types don't derive PartialEq —
    /// compare every stamped field explicitly; this IS the parity contract).
    fn assert_manifests_equal(a: &Manifest, b: &Manifest) {
        assert_eq!(a.schema_version, b.schema_version);
        assert_eq!(a.kind, b.kind);
        assert_eq!(a.book.id, b.book.id);
        assert_eq!(a.book.title, b.book.title);
        assert_eq!(a.book.author, b.book.author);
        assert_eq!(a.book.source_format, b.book.source_format);
        assert_eq!(a.book.chapter_count, b.book.chapter_count);
        assert_eq!(a.book.voice_id, b.book.voice_id);
        assert_eq!(a.book.created_at, b.book.created_at);
        assert_eq!(a.book.updated_at, b.book.updated_at);
        assert_eq!(a.book.progress_fraction, b.book.progress_fraction);
        assert_eq!(a.audio.present, b.audio.present);
        assert_eq!(a.audio.codec, b.audio.codec);
        assert_eq!(a.audio.norm_version, b.audio.norm_version);
        assert_eq!(a.audio.segment_count, b.audio.segment_count);
        assert_eq!(a.generator.app, b.generator.app);
        assert_eq!(a.generator.version, b.generator.version);
    }

    #[test]
    fn streaming_stamp_matches_in_memory_stamp_field_for_field() {
        // Same stub-synthesized input through both entry points must produce
        // equal manifests (field-for-field) and equal audio maps on read-back.
        // The input's manifest voice deliberately differs from the synth voice
        // so the rewrite-before-synth contract is exercised on both paths.
        let make_chapters = || {
            vec![
                ChapterText::new(
                    "bk_test",
                    0,
                    "Ch",
                    vec!["Hello world.".into(), "Second paragraph.".into()],
                ),
                ChapterText::new("bk_test", 1, "Two", vec!["Across chapters.".into()]),
            ]
        };

        let mut mem = text_only_bundle("en_US-lessac-medium", make_chapters());
        synth_and_stamp(
            &mut mem,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            TEST_APP,
            None,
        )
        .expect("in-memory path succeeds");
        let mut mem_buf = Cursor::new(Vec::new());
        write_book_bundle(&mem, &mut mem_buf).expect("in-memory write succeeds");

        let mut streaming = text_only_bundle("en_US-lessac-medium", make_chapters());
        let writer =
            taletrek_synth::BundleWriter::new(Cursor::new(Vec::new()), &streaming.chapters)
                .expect("writer opens");
        let (cursor, count) = synth_and_stamp_streaming(
            &mut streaming,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            TEST_APP,
            None,
            writer,
        )
        .expect("streaming path succeeds");

        let a = read_book_bundle(&mem_buf.into_inner()).unwrap();
        let b = read_book_bundle(&cursor.into_inner()).unwrap();
        assert_manifests_equal(&a.manifest, &b.manifest);
        assert_eq!(a.audio.len(), b.audio.len());
        for (key, seg) in &a.audio {
            let other = b.audio.get(key).expect("same keys");
            assert_eq!(seg.bytes, other.bytes);
            assert_eq!(seg.codec, other.codec);
        }
        assert_eq!(count, b.manifest.audio.segment_count);

        // The streaming caller's bundle manifest was stamped in place too —
        // the same in-place discipline as the in-memory path.
        assert_eq!(streaming.manifest.book.voice_id, "en_US-ryan-medium");
        assert!(streaming.manifest.audio.present);
        assert_eq!(streaming.manifest.generator.app, TEST_APP);
    }

    #[test]
    fn streaming_stamp_segment_count_reflects_dedup() {
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["Repeat.".into(), "Repeat.".into()],
            )],
        );
        let writer = taletrek_synth::BundleWriter::new(Cursor::new(Vec::new()), &b.chapters)
            .expect("writer opens");
        let (cursor, count) = synth_and_stamp_streaming(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            TEST_APP,
            None,
            writer,
        )
        .expect("streaming path succeeds");

        assert_eq!(count, 1, "duplicate paragraphs collapse to one entry");
        let back = read_book_bundle(&cursor.into_inner()).unwrap();
        assert_eq!(back.audio.len(), 1);
        assert_eq!(back.manifest.audio.segment_count, 1);
    }

    #[test]
    fn streaming_stamp_aborts_with_the_same_typing_on_synth_failure() {
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["   \n   ".into()],
            )],
        );
        let writer = taletrek_synth::BundleWriter::new(Cursor::new(Vec::new()), &b.chapters)
            .expect("writer opens");
        let err = synth_and_stamp_streaming(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            TEST_APP,
            None,
            writer,
        )
        .expect_err("empty paragraph must error");
        assert!(
            matches!(err, StampError::Synth(_)),
            "expected StampError::Synth, got {err:?}"
        );
    }

    // ---- resynth_and_stamp ----

    #[test]
    fn resynth_and_stamp_updates_manifest_voice_and_rekeys_segments() {
        // Start from a full bundle under voice A; resynth to voice B; assert
        // the manifest's voiceId flipped to B and every segment is keyed under B.
        let mut b = bundle(
            "en_US-lessac-medium",
            true,
            vec![
                ChapterText::new(
                    "bk_test",
                    0,
                    "Ch",
                    vec!["Hello world.".into(), "Second.".into()],
                ),
                ChapterText::new("bk_test", 1, "Two", vec!["Across chapters.".into()]),
            ],
        );

        resynth_and_stamp(
            &mut b,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            TEST_APP,
            None,
        )
        .expect("resynth should succeed with stub runner");

        // Manifest voice flipped to the new voice.
        assert_eq!(b.manifest.book.voice_id, "en_US-ryan-medium");
        // Audio marked present + segment count matches distinct paragraphs.
        assert!(b.manifest.audio.present);
        assert_eq!(b.manifest.audio.segment_count, 3);
        // Generator carries the caller-supplied app.
        assert_eq!(b.manifest.generator.app, TEST_APP);

        // Every segment keyed under the new voice.
        let new_voice = "en_US-ryan-medium";
        for text in &["Hello world.", "Second.", "Across chapters."] {
            let key = cache_key(new_voice, text);
            assert!(
                b.audio.contains_key(&key),
                "missing segment keyed under new voice: {key}"
            );
        }
        // No segments keyed under the old voice survive.
        let old_voice = "en_US-lessac-medium";
        for text in &["Hello world.", "Second.", "Across chapters."] {
            let key = cache_key(old_voice, text);
            assert!(
                !b.audio.contains_key(&key),
                "stale segment under old voice survived: {key}"
            );
        }
    }

    #[test]
    fn resynth_and_stamp_discards_stale_audio_from_previous_voice() {
        // A full bundle carrying audio under the OLD voice. After resynth, none
        // of those old segments survive — synth_and_stamp replaces (not
        // extends) the audio map.
        let mut b = bundle(
            "en_US-lessac-medium",
            true,
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["Hello world.".into()],
            )],
        );
        // Pre-populate audio under the old voice (as a prior synth run would).
        let old_key = cache_key("en_US-lessac-medium", "Hello world.");
        b.audio.insert(
            old_key.clone(),
            AudioSegment {
                key: old_key.clone(),
                codec: AudioCodec::Wav,
                bytes: canonical_wav(&[0xFF]),
            },
        );
        assert_eq!(
            b.audio.len(),
            1,
            "fixture: one stale segment under old voice"
        );

        resynth_and_stamp(
            &mut b,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            TEST_APP,
            None,
        )
        .expect("resynth succeeds");

        // The old segment is gone; only the new-voice segment remains.
        assert!(
            !b.audio.contains_key(&old_key),
            "old-voice segment must be discarded"
        );
        let new_key = cache_key("en_US-ryan-medium", "Hello world.");
        assert!(
            b.audio.contains_key(&new_key),
            "new-voice segment must be present"
        );
        assert_eq!(b.audio.len(), 1);
    }

    #[test]
    fn resynth_and_stamp_accepts_text_only_input() {
        // resynth accepts text-only input too (it's "synth + voice rewrite").
        let mut b = text_only_bundle(
            "en_US-lessac-medium",
            vec![ChapterText::new("bk_test", 0, "Ch", vec!["Hi.".into()])],
        );

        resynth_and_stamp(
            &mut b,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            TEST_APP,
            None,
        )
        .expect("resynth on text-only should succeed");

        assert_eq!(b.manifest.book.voice_id, "en_US-ryan-medium");
        assert!(b.manifest.audio.present);
        assert!(b.audio.contains_key(&cache_key("en_US-ryan-medium", "Hi.")));
    }
}
