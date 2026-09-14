//! Parallel synth engine: synthesize every paragraph of a bundle's chapters
//! into content-addressed audio segments using a bounded `rayon` pool.
//!
//! This module is pure orchestration — all synth logic (normalize → split →
//! Piper → concat → encode) lives in [`taletrek_synth::synthesize_paragraph`].
//! The engine here:
//! - flattens every chapter's paragraphs into one work list,
//! - splits it into at most `jobs` contiguous chunks and runs them through a
//!   `rayon` thread pool sized by `--jobs`,
//! - constructs **one** [`taletrek_synth::PiperRunner`] per chunk via
//!   `make_runner` (the per-thread cost model: a runner that owns a loaded
//!   model — sherpa — loads it once per chunk, never per paragraph; the
//!   stateless subprocess runner is unaffected), and
//! - shares a single `&E` [`taletrek_synth::Encoder`] by reference
//!   (`encode(&self)` is stateless).
//!
//! On the first paragraph that errors, the whole run aborts (rayon short-
//! circuits `collect::<Result<..>>`). Continue-on-error (`--keep-going`) is a
//! follow-up; v1 aborts.
//!
//! # Streaming vs. accumulation
//!
//! [`synth_paragraphs_into`] is the engine's primary shape: every finished
//! segment is handed to a shared [`SegmentSink`] **by value** instead of being
//! accumulated — so a sink that writes straight to disk (the streaming
//! `BundleWriter`) keeps peak memory at one segment, not the whole book's
//! audio. Dedup is the **sink's** job: the engine still synthesizes and
//! delivers every occurrence of an identical paragraph; a collapsing sink
//! (the streaming writer's written-keys set, or the collecting wrapper below)
//! keeps one. [`synth_all_paragraphs`] is the legacy accumulating flavor — a
//! thin wrapper collecting the sink's deliveries into a `HashMap` — kept for
//! library nesting, tests, and small/compat paths.
//!
//! Re-exported at the crate root ([`synth_all_paragraphs`],
//! [`synth_paragraphs_into`], [`SegmentSink`], [`SynthJobError`]); hosts reach
//! this through their stamping glue (`bundle_io::synth_and_stamp` on the
//! desktop).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;
use thiserror::Error;

use taletrek_synth::synth::{synthesize_paragraph, PiperRunner, SynthError, SynthOptions};
use taletrek_synth::{AudioSegment, BookBundle, BundleError, Encoder};

use crate::ProgressSink;

/// All the ways a parallel synth run can fail. Typed so the host (desktop's
/// `bundle_io` / server's synth runner) can branch and so `?` lifts cleanly
/// into `anyhow` at the binary boundary.
#[derive(Debug, Error)]
pub enum SynthJobError {
    /// The `rayon` thread pool could not be built for the requested job count.
    /// Carries the requested `jobs` so the user can adjust `--jobs`.
    #[error("failed to build synth thread pool with {jobs} jobs: {source}")]
    PoolBuild {
        /// The job count passed to `--jobs` (or the `num_cpus` default).
        jobs: usize,
        /// Underlying `rayon` build error.
        #[source]
        source: rayon::ThreadPoolBuildError,
    },

    /// A paragraph failed to synthesize (Piper / encoder failure, or empty
    /// text after normalization). v1 aborts on the first such error.
    #[error(transparent)]
    Synth(#[from] SynthError),

    /// The [`SegmentSink`] rejected a completed segment — e.g. the streaming
    /// bundle writer failed a write. Distinct from [`SynthJobError::Synth`]:
    /// the synthesis itself succeeded; the *output* write did not.
    #[error(transparent)]
    Sink(#[from] BundleError),
}

/// The boxed delivery closure [`SegmentSink`] wraps: `(key, segment) ->
/// Result<(), BundleError>`, `Send` so pool chunks share it.
type SegmentDeliver = Box<dyn FnMut(String, AudioSegment) -> Result<(), BundleError> + Send>;

/// Shared delivery target for [`synth_paragraphs_into`]: pool threads hand
/// each finished segment to the wrapped closure **by value**, one call per
/// completed paragraph.
///
/// The closure is boxed behind a `Mutex` (interior mutability is what makes
/// `&SegmentSink` shareable across rayon chunks — `FnMut` cannot be `Sync` on
/// its own). The sink is **fallible**: an `Err` aborts the run as
/// [`SynthJobError::Sink`], so a disk-full or corrupt-write unwinds the pool
/// exactly like a synthesis failure. Dedup is the sink's responsibility — the
/// engine delivers every occurrence.
pub struct SegmentSink {
    deliver: Mutex<SegmentDeliver>,
}

impl SegmentSink {
    /// Wrap a delivery closure. `Send + 'static` because the closure may
    /// capture owned handles (e.g. an `Arc<Mutex<BundleWriter<_>>>`) that the
    /// caller keeps a clone of to retrieve after the run.
    pub fn new(
        f: impl FnMut(String, AudioSegment) -> Result<(), BundleError> + Send + 'static,
    ) -> Self {
        Self {
            deliver: Mutex::new(Box::new(f)),
        }
    }

    fn deliver(&self, key: String, seg: AudioSegment) -> Result<(), BundleError> {
        let mut f = self
            .deliver
            .lock()
            .map_err(|_| BundleError::Io(std::io::Error::other("segment sink mutex poisoned")))?;
        f(key, seg)
    }
}

/// Flatten every chapter's paragraphs into a single borrowed work list, in
/// chapter then paragraph order. Pure projection — no allocation beyond the
/// one `Vec<&str>`.
fn collect_paragraphs(bundle: &BookBundle) -> Vec<&str> {
    bundle
        .chapters
        .iter()
        .flat_map(|ch| ch.paragraphs.iter().map(String::as_str))
        .collect()
}

/// Synthesize every paragraph across all chapters of `bundle`, handing each
/// finished segment to `sink` **by value** — the streaming shape. See the
/// [module docs](self#streaming-vs-accumulation) for the accumulation
/// contrast; the chunking/pool/cost-model/abort/progress behavior is
/// identical to [`synth_all_paragraphs`]:
/// - `voice_id` is the cache-key namespace; `voice_model` is the resolved
///   `.onnx` path on disk.
/// - `make_runner` fires once **per chunk** (at most `jobs` constructions).
/// - `encoder` is shared `&E` across all tasks.
/// - `jobs` bounds the pool (clamped to `>= 1`).
/// - aborts on the first paragraph *or sink* error →
///   [`SynthJobError::Synth`] / [`SynthJobError::Sink`].
/// - `progress`, when `Some`, emits a `synth [done/total] pct%` line after
///   each successful paragraph (before delivery).
#[allow(clippy::too_many_arguments)] // mirrors synth_all_paragraphs + the sink param
pub fn synth_paragraphs_into<R, E, F>(
    bundle: &BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    progress: Option<&dyn ProgressSink>,
    sink: &SegmentSink,
) -> Result<(), SynthJobError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    let paragraphs = collect_paragraphs(bundle);

    // Bound the pool at `--jobs` (clamped to >= 1; `num_threads(0)` would
    // panic). The default `num_cpus` is resolved by the caller.
    let jobs = jobs.max(1);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(jobs)
        .build()
        .map_err(|source| SynthJobError::PoolBuild { jobs, source })?;

    // Progress counter shared across worker threads. Relaxed ordering is
    // enough: each fetch_add yields a unique monotonic index; no other memory
    // needs synchronizing with it.
    let total = paragraphs.len();
    let done = AtomicUsize::new(0);

    // Split into at most `jobs` chunks: ceil(total/jobs) paragraphs each, so
    // `make_runner` fires at most `jobs` times per run (one construction per
    // chunk — the per-thread cost model). Chunk size floors at 1 (fewer
    // paragraphs than jobs → one chunk per paragraph, never per job slot);
    // `par_chunks(0)` would panic.
    let chunk_size = total.div_ceil(jobs).max(1);

    // Run the chunked map inside our bounded pool. Each chunk constructs one
    // runner (owned for the chunk's lifetime — `&mut R` can't cross threads)
    // and processes its paragraphs sequentially, borrowing the shared `&E`
    // encoder by ref. Each successful paragraph reports progress, then moves
    // into the sink — nothing accumulates. `collect::<Result>` makes rayon
    // short-circuit on the first chunk error → v1 "abort on first error".
    let results: Result<Vec<()>, SynthJobError> = pool.install(|| {
        paragraphs
            .par_chunks(chunk_size)
            .map(|chunk| {
                let mut runner = make_runner();
                for text in chunk {
                    let mut opts = SynthOptions::new(voice_model, &mut runner, encoder);
                    let synthesized = synthesize_paragraph(voice_id, text, &mut opts)
                        .map_err(SynthJobError::Synth)?;
                    if let Some(p) = progress {
                        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                        p.synth_step(n, total);
                    }
                    let seg = AudioSegment {
                        key: synthesized.cache_key.clone(),
                        codec: synthesized.codec,
                        bytes: synthesized.audio,
                    };
                    sink.deliver(synthesized.cache_key, seg)
                        .map_err(SynthJobError::Sink)?;
                }
                Ok(())
            })
            .collect()
    });

    results.map(|_| ())
}

/// Synthesize every paragraph across all chapters of `bundle` into a
/// content-addressed `HashMap<cache_key, AudioSegment>` — the **accumulating**
/// flavor, now a thin wrapper over [`synth_paragraphs_into`] (a sink that
/// collects deliveries into the map). Behavior is identical to the
/// pre-streaming engine: duplicate paragraphs still synthesize and collapse
/// via `HashMap` insert (last wins, content-identical anyway).
///
/// - `voice_id` is the cache-key namespace (and ends up in the manifest's
///   `book.voiceId`); `voice_model` is the resolved `.onnx` path on disk.
/// - `make_runner` is called once **per chunk** to produce a runner owned by
///   that chunk for its whole lifetime. The work list is split into at most
///   `jobs` contiguous chunks (ceil(total/jobs) paragraphs each), so at most
///   `jobs` runner constructions happen per run — the per-thread cost model
///   model-loaded runners (sherpa) need. Production passes a closure
///   constructing from the piper binary path or the voice model; tests pass a
///   closure returning a stub runner.
/// - `encoder` is shared by `&E` across all tasks (`encode(&self)` is
///   stateless), matching the spec's "one shared `OpusEncoder`" decision.
/// - `jobs` bounds the pool (clamped to `>= 1`). The default `num_cpus` is
///   resolved by the caller.
///
/// Aborts on the first paragraph error → [`SynthJobError::Synth`]. Prefer
/// [`synth_paragraphs_into`] + a streaming sink for large documents — this
/// flavor holds every segment in memory.
///
/// `progress`, when `Some`, emits a `synth [done/total] pct%` line after each
/// successful paragraph. Under parallelism the `done` counter is monotonic but
/// lines may interleave out of strict order; tests pin `jobs: 1` for
/// deterministic ordering. `None` is silent.
pub fn synth_all_paragraphs<R, E, F>(
    bundle: &BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    progress: Option<&dyn ProgressSink>,
) -> Result<HashMap<String, AudioSegment>, SynthJobError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    let segments = std::sync::Arc::new(Mutex::new(HashMap::new()));
    let collecting = segments.clone();
    let sink = SegmentSink::new(move |key, seg| {
        collecting
            .lock()
            .map_err(|_| BundleError::Io(std::io::Error::other("segment map mutex poisoned")))?
            .insert(key, seg);
        Ok(())
    });
    synth_paragraphs_into(
        bundle,
        voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        progress,
        &sink,
    )?;
    drop(sink);
    Ok(Arc::try_unwrap(segments)
        .expect("collecting sink dropped after the run")
        .into_inner()
        .expect("segment map mutex uncontended"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use taletrek_synth::synth::{PiperRunner, SynthError};
    use taletrek_synth::{
        cache_key, AudioCodec, AudioMeta, BookBundle, BookMeta, ChapterText, Generator, Manifest,
        ManifestKind, WavPassthrough, NORM_VERSION,
    };

    use crate::Progress;

    /// Canonical mono 16-bit 16 kHz WAV with `pcm` as its data payload — the
    /// shape Piper emits on stdout and `concat_wav` / `wav_duration` expect.
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
    /// `PiperRunner` is called per-paragraph by the engine, so no state needed.
    struct StubRunner;

    impl PiperRunner for StubRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    /// Build a minimal text-only bundle carrying the given chapters. The
    /// manifest fields that synth_job doesn't touch are filled with sentinels.
    fn text_only_bundle(chapters: Vec<ChapterText>) -> BookBundle {
        let chapter_count = u32::try_from(chapters.len()).unwrap();
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
                    voice_id: "en_US-hfc_female-medium".into(),
                    created_at: 0,
                    updated_at: 0,
                    progress_fraction: None,
                },
                audio: AudioMeta {
                    present: false,
                    codec: AudioCodec::Opus,
                    norm_version: NORM_VERSION.parse().unwrap(),
                    segment_count: 0,
                },
                generator: Generator {
                    app: "taletrek-desktop".into(),
                    version: "0.1.0".into(),
                },
            },
            chapters,
            audio: HashMap::new(),
        }
    }

    #[test]
    fn every_paragraph_yields_a_segment_keyed_by_cache_key() {
        let bundle = text_only_bundle(vec![
            ChapterText::new(
                "bk_test",
                0,
                "Chapter One",
                vec!["Hello world.".into(), "A second paragraph.".into()],
            ),
            ChapterText::new("bk_test", 1, "Chapter Two", vec!["Across chapters.".into()]),
        ]);
        let voice = "en_US-ryan-medium";

        let segments = synth_all_paragraphs(
            &bundle,
            voice,
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            None,
        )
        .expect("synth should succeed with a stub runner");

        // Every distinct paragraph produced a segment, keyed by cache_key.
        let expected_keys: Vec<String> =
            ["Hello world.", "A second paragraph.", "Across chapters."]
                .iter()
                .map(|t| cache_key(voice, t))
                .collect();
        for key in &expected_keys {
            assert!(segments.contains_key(key), "missing segment for key {key}");
        }
        assert_eq!(segments.len(), expected_keys.len());

        // Each segment carries its key + the WAV bytes the stub produced, and
        // WavPassthrough reports the WAV codec.
        for key in &expected_keys {
            let seg = &segments[key];
            assert_eq!(seg.key, *key);
            assert_eq!(seg.codec, AudioCodec::Wav);
            assert_eq!(seg.bytes, canonical_wav(&[0x01, 0x02, 0x03, 0x04]));
        }
    }

    #[test]
    fn identical_paragraphs_dedup_into_one_segment() {
        // Content addressing: the same text under the same voice → same key,
        // so two identical paragraphs collapse to one segment. This matches
        // the SPA's audio cache semantics.
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["Repeat me.".into(), "Repeat me.".into()],
        )]);
        let voice = "en_US-hfc_female-medium";

        let segments = synth_all_paragraphs(
            &bundle,
            voice,
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
        )
        .expect("stub runner succeeds");
        let expected_key = cache_key(voice, "Repeat me.");
        assert_eq!(segments.len(), 1, "duplicate paragraphs must dedup");
        assert!(segments.contains_key(&expected_key));
    }

    #[test]
    fn make_runner_fires_once_per_chunk_not_per_paragraph() {
        // The per-thread cost model (sherpa: one model load per runner): 8
        // paragraphs at jobs=2 → chunk size 4 → exactly 2 runner
        // constructions, deterministic regardless of scheduling. A
        // per-paragraph factory would fire 8 times (a model reload per
        // paragraph — the T3 wiring hazard).
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec![
                "One.".into(),
                "Two.".into(),
                "Three.".into(),
                "Four.".into(),
                "Five.".into(),
                "Six.".into(),
                "Seven.".into(),
                "Eight.".into(),
            ],
        )]);

        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        let segments = synth_all_paragraphs(
            &bundle,
            "v",
            Path::new("/dev/null"),
            move || {
                seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                StubRunner
            },
            &WavPassthrough,
            2,
            None,
        )
        .expect("stub runner succeeds");

        assert_eq!(segments.len(), 8, "every paragraph still yields a segment");
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "one runner construction per chunk (jobs=2 → 2 chunks of 4)"
        );
    }

    #[test]
    fn make_runner_never_exceeds_paragraph_count_when_jobs_high() {
        // jobs > paragraphs → chunk size floors at 1 → one construction per
        // paragraph (2), never per job slot (8).
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["One.".into(), "Two.".into()],
        )]);

        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        let segments = synth_all_paragraphs(
            &bundle,
            "v",
            Path::new("/dev/null"),
            move || {
                seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                StubRunner
            },
            &WavPassthrough,
            8,
            None,
        )
        .expect("stub runner succeeds");

        assert_eq!(segments.len(), 2);
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "one construction per chunk (2 chunks of 1), not per job slot"
        );
    }

    #[test]
    fn jobs_one_still_synthesizes_every_paragraph() {
        // Parallel != num_cpus must still be correct: a single-worker pool is
        // just sequential, and every paragraph still yields a segment.
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["One.".into(), "Two.".into(), "Three.".into()],
        )]);
        let voice = "v";

        let segments = synth_all_paragraphs(
            &bundle,
            voice,
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
        )
        .expect("jobs=1 should work");
        assert_eq!(segments.len(), 3);
    }

    #[test]
    fn aborts_on_first_synthesis_error() {
        // A paragraph that normalizes to empty → SynthError::EmptyText, which
        // the engine surfaces (v1 aborts) rather than skipping.
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["   \n   ".into()],
        )]);

        let err = synth_all_paragraphs(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            None,
        )
        .expect_err("empty paragraph must error");
        assert!(
            matches!(err, SynthJobError::Synth(SynthError::EmptyText)),
            "expected Synth(EmptyText), got {err:?}"
        );
    }

    #[test]
    fn empty_bundle_produces_no_segments() {
        // No chapters → no paragraphs → empty segment map (not an error).
        let bundle = text_only_bundle(vec![]);
        let segments = synth_all_paragraphs(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            None,
        )
        .expect("empty bundle should not error");
        assert!(segments.is_empty());
    }

    #[test]
    fn progress_emits_one_line_per_paragraph_in_order_with_jobs_one() {
        // With a single worker, paragraphs complete in chapter/paragraph order,
        // so the captured synth lines are exactly [1/3] 33%, [2/3] 66%, [3/3]
        // 100%. (Parallel runs would still be monotonic but could interleave.)
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["One.".into(), "Two.".into(), "Three.".into()],
        )]);

        let captured = Captured::default();
        let progress = Progress::new(Box::new(captured.clone()));

        synth_all_paragraphs(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1, // deterministic ordering
            Some(&progress),
        )
        .expect("synth succeeds");

        let out = captured.take();
        assert_eq!(out, "synth [1/3] 33%\nsynth [2/3] 66%\nsynth [3/3] 100%\n");
    }

    #[test]
    fn progress_skips_total_zero_so_empty_bundle_is_silent() {
        // No paragraphs → total 0 → synth_step is a no-op; nothing is written.
        let bundle = text_only_bundle(vec![]);
        let captured = Captured::default();
        let progress = Progress::new(Box::new(captured.clone()));

        synth_all_paragraphs(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            Some(&progress),
        )
        .expect("empty bundle");

        assert_eq!(captured.take(), "", "empty bundle must emit no synth lines");
    }

    #[test]
    fn progress_reports_no_steps_after_a_paragraph_error() {
        // A paragraph that normalizes to empty errors immediately; inspect only
        // reports on Ok results, so no synth line is emitted before the abort.
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["   \n   ".into()],
        )]);
        let captured = Captured::default();
        let progress = Progress::new(Box::new(captured.clone()));

        let _ = synth_all_paragraphs(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            Some(&progress),
        );

        assert_eq!(
            captured.take(),
            "",
            "no progress on the errored paragraph (inspect reports Ok only)"
        );
    }

    // ---- synth_paragraphs_into (sink engine — streaming-synth) ----

    /// A recording sink: captures `(key, bytes-len)` per delivery. Fallibility
    /// is opt-in via `fail_after` — deliveries beyond that count return a
    /// `BundleError`, exercising the abort path.
    type Deliveries = std::sync::Arc<std::sync::Mutex<Vec<(String, usize)>>>;

    struct RecordingSink {
        deliveries: Deliveries,
        fail_after: Option<usize>,
    }

    impl RecordingSink {
        fn new() -> Self {
            Self {
                deliveries: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
                fail_after: None,
            }
        }

        fn into_sink(self) -> (SegmentSink, Deliveries) {
            let deliveries = self.deliveries.clone();
            let fail_after = self.fail_after;
            let sink = SegmentSink::new(move |key, seg| {
                let mut seen = deliveries.lock().unwrap();
                if let Some(limit) = fail_after {
                    if seen.len() >= limit {
                        return Err(taletrek_synth::BundleError::InvalidAudioKey(format!(
                            "sink-fail-after-{limit}"
                        )));
                    }
                }
                seen.push((key, seg.bytes.len()));
                Ok(())
            });
            (sink, self.deliveries)
        }
    }

    #[test]
    fn sink_engine_delivers_every_occurrence_dupes_included() {
        // Dedup is the SINK's job now: the engine synthesizes and delivers
        // every paragraph occurrence, so two identical paragraphs produce two
        // deliveries (the recording sink sees both; a HashMap sink collapses
        // them — pinned by the wrapper tests above).
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["Repeat me.".into(), "Repeat me.".into(), "Unique.".into()],
        )]);

        let (sink, deliveries) = RecordingSink::new().into_sink();
        synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            None,
            &sink,
        )
        .expect("stub runner succeeds");

        let seen = deliveries.lock().unwrap();
        assert_eq!(seen.len(), 3, "one delivery per paragraph occurrence");
        // Delivery ORDER across parallel chunks is nondeterministic (the sink
        // serializes but does not order) — assert the delivery multiset: the
        // repeated paragraph delivered twice, the unique one once.
        let repeat_key = cache_key("v", "Repeat me.");
        let unique_key = cache_key("v", "Unique.");
        assert_eq!(
            seen.iter().filter(|(k, _)| *k == repeat_key).count(),
            2,
            "identical paragraphs deliver every occurrence (dedup is the sink's)"
        );
        assert_eq!(
            seen.iter().filter(|(k, _)| *k == unique_key).count(),
            1,
            "every distinct paragraph delivered"
        );
        assert_eq!(
            seen[0].1,
            canonical_wav(&[0x01, 0x02, 0x03, 0x04]).len(),
            "segments carry the synthesized bytes"
        );
    }

    #[test]
    fn sink_engine_runner_fires_once_per_chunk() {
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec![
                "One.".into(),
                "Two.".into(),
                "Three.".into(),
                "Four.".into(),
            ],
        )]);

        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        let (sink, _) = RecordingSink::new().into_sink();
        synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            move || {
                seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                StubRunner
            },
            &WavPassthrough,
            2,
            None,
            &sink,
        )
        .expect("stub runner succeeds");

        assert_eq!(
            calls.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "one runner per chunk through the sink engine too"
        );
    }

    #[test]
    fn sink_engine_progress_is_unchanged_at_jobs_one() {
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["One.".into(), "Two.".into(), "Three.".into()],
        )]);

        let captured = Captured::default();
        let progress = Progress::new(Box::new(captured.clone()));
        let (sink, _) = RecordingSink::new().into_sink();

        synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            Some(&progress),
            &sink,
        )
        .expect("synth succeeds");

        assert_eq!(
            captured.take(),
            "synth [1/3] 33%\nsynth [2/3] 66%\nsynth [3/3] 100%\n"
        );
    }

    #[test]
    fn sink_engine_aborts_on_first_sink_error() {
        // A failing sink must unwind the pool exactly like a synth error:
        // first error aborts, no further paragraphs are synthesized or
        // delivered, and the error is the typed Sink variant.
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["One.".into(), "Two.".into(), "Three.".into()],
        )]);

        let recorder = RecordingSink {
            deliveries: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            fail_after: Some(1),
        };
        let (sink, deliveries) = recorder.into_sink();

        let err = synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
            &sink,
        )
        .expect_err("sink error must abort");
        assert!(
            matches!(err, SynthJobError::Sink(_)),
            "expected Sink(_), got {err:?}"
        );
        assert_eq!(
            deliveries.lock().unwrap().len(),
            1,
            "the failing delivery is recorded, nothing after it"
        );
    }

    #[test]
    fn sink_engine_aborts_on_synthesis_error_through_sink_path() {
        // The legacy abort semantic (EmptyText) survives the refactor: same
        // error, surfaced through the sink engine.
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["   \n   ".into()],
        )]);
        let (sink, deliveries) = RecordingSink::new().into_sink();

        let err = synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            None,
            &sink,
        )
        .expect_err("empty paragraph must error");
        assert!(
            matches!(err, SynthJobError::Synth(SynthError::EmptyText)),
            "expected Synth(EmptyText), got {err:?}"
        );
        assert!(deliveries.lock().unwrap().is_empty());
    }

    #[test]
    fn sink_engine_empty_bundle_delivers_nothing() {
        let bundle = text_only_bundle(vec![]);
        let (sink, deliveries) = RecordingSink::new().into_sink();
        synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            None,
            &sink,
        )
        .expect("empty bundle should not error");
        assert!(deliveries.lock().unwrap().is_empty());
    }

    /// A clonable `Write` that records into a shared `Arc<Mutex<Vec<u8>>>` so a
    /// test can read what `Progress` wrote while the sink owns the box.
    #[derive(Clone, Default)]
    struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl Captured {
        fn take(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().split_off(0)).unwrap()
        }
    }

    impl std::io::Write for Captured {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
