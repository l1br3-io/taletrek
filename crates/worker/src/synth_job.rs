//! Parallel synth engine: synthesize every paragraph of a bundle's chapters
//! into content-addressed audio segments using a bounded `rayon` pool.
//!
//! This module is pure orchestration — all synth logic (normalize → split →
//! Piper → concat → encode) lives in [`taletrek_synth::synthesize_paragraph`]
//! and the crate functions it composes from. The engine here:
//! - flattens every chapter's paragraphs into one work list,
//! - **plans every paragraph up front** (cache key, sentence chunks under the
//!   engine's effective cap, normalized char weight) — planning needs the cap
//!   before any predict could apply it, so the first pool runner doubles as
//!   the cap probe (constructed eagerly, never an extra construction),
//! - enqueues **sentence-chunk tasks** in LPT order (longest paragraph's
//!   chunks first) drained by a shared pool — work stealing across chunk
//!   granularity is what kills the straggler tail a contiguous-chunk engine
//!   cannot, and
//! - constructs **at most** `min(jobs, tasks)` [`taletrek_synth::PiperRunner`]s
//!   eagerly into a checkout/checkin fleet (the per-thread cost model: a
//!   runner that owns a loaded model — sherpa — loads it once per fleet slot,
//!   never per paragraph; the stateless subprocess runner is unaffected),
//!   sharing a single `&E` [`taletrek_synth::Encoder`] by reference
//!   (`encode(&self)` is stateless).
//!
//! Per-paragraph assembly stays the delivery unit: whichever worker predicts
//! a paragraph's last chunk concatenates the shared partial slots (chunk
//! order, not completion order — deterministic bytes), encodes, reports
//! progress, and delivers — so segments and cache keys are byte-identical to
//! the per-paragraph pipeline. In-flight memory is bounded by at most one
//! partially-assembled paragraph per worker (`jobs` × largest-paragraph WAV),
//! a rounding error next to the N model arenas that stay the real envelope.
//!
//! On the first chunk, encode, or sink error, the whole run aborts (rayon
//! short-circuits `try_for_each`). A paragraph that normalizes to empty
//! fails at the planning stage — before any synth work happens.
//! Continue-on-error (`--keep-going`) is a follow-up; v1 aborts. Host
//! cancellation stays cooperative and per-chunk: the host's runner decorator
//! checks its flag before every predict (finer granularity than the old
//! per-paragraph check) and raises [`SynthError::Cancelled`].
//!
//! # Streaming vs. accumulation
//!
//! [`synth_paragraphs_into`] is the engine's primary shape: every finished
//! segment is handed to a shared [`SegmentSink`] **by value** instead of being
//! accumulated — so a sink that writes straight to disk (the streaming
//! `BundleWriter`) keeps peak memory at one segment, not the whole book's
//! audio. The engine's planning stage dedups by cache key: each distinct key
//! is synthesized and delivered **exactly once** (identical paragraphs are a
//! free skip, not a re-synthesis), so a repetitive book pays for its
//! distinct text only. [`synth_all_paragraphs`] is the legacy accumulating
//! flavor — a thin wrapper collecting the sink's deliveries into a `HashMap`
//! — kept for library nesting, tests, and small/compat paths.
//!
//! Re-exported at the crate root ([`synth_all_paragraphs`],
//! [`synth_paragraphs_into`], [`SegmentSink`], [`SynthJobError`]); hosts reach
//! this through their stamping glue (`bundle_io::synth_and_stamp` on the
//! desktop).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use rayon::prelude::*;
use thiserror::Error;

use taletrek_synth::pcm::concat_wav;
use taletrek_synth::synth::{PiperRunner, SynthError};
use taletrek_synth::{
    cache_key, normalize_for_speech, split_for_speech, AudioSegment, BookBundle, BundleError,
    Encoder, MAX_SYNTH_CHARS,
};

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
type SegmentDeliver<'a> =
    Box<dyn FnMut(String, AudioSegment) -> Result<(), BundleError> + Send + 'a>;

/// Shared delivery target for [`synth_paragraphs_into`]: pool threads hand
/// each finished segment to the wrapped closure **by value**, one call per
/// distinct key.
///
/// The closure is boxed behind a `Mutex` (interior mutability is what makes
/// `&SegmentSink` shareable across rayon chunks — `FnMut` cannot be `Sync` on
/// its own). The sink is **fallible**: an `Err` aborts the run as
/// [`SynthJobError::Sink`], so a disk-full or corrupt-write unwinds the pool
/// exactly like a synthesis failure. The engine's planning stage already
/// dedups — each distinct key arrives exactly once (a sink may still keep
/// its own written-keys guard defensively).
///
/// The lifetime parameter lets a sink borrow host context (a progress
/// reporter, a shared tracker) instead of cloning it behind `Arc` —
/// `SegmentSink::new` accepts any closure bounded by `'a`, and `'static`
/// closures (the common case) infer as before.
pub struct SegmentSink<'a> {
    deliver: Mutex<SegmentDeliver<'a>>,
    _borrow: std::marker::PhantomData<&'a ()>,
}

impl<'a> SegmentSink<'a> {
    /// Wrap a delivery closure. `Send` so pool threads share it; the
    /// lifetime bound (not `'static`) lets the closure borrow host context.
    pub fn new(f: impl FnMut(String, AudioSegment) -> Result<(), BundleError> + Send + 'a) -> Self {
        Self {
            deliver: Mutex::new(Box::new(f)),
            _borrow: std::marker::PhantomData,
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

/// One paragraph occurrence's planned work: the content-addressed key over
/// the ORIGINAL text (byte-parity with [`taletrek_synth::cache_key`]), the
/// sentence chunks the pool will predict (split under the engine's effective
/// cap), and the normalized char count used as the LPT weight.
struct PlannedParagraph {
    key: String,
    chunks: Vec<String>,
    weight: usize,
}

/// The shared assembly state for one paragraph occurrence: one slot per
/// planned chunk (filled by whichever worker predicts it) plus a countdown
/// of unfinished chunks. The worker that takes the countdown to zero
/// assembles the segment (concat → encode → deliver + progress).
struct PartialParagraph {
    key: String,
    slots: Vec<Mutex<Option<Vec<u8>>>>,
    remaining: AtomicUsize,
}

/// One pool work item: predict `chunks[chunk]` of paragraph `para`.
struct ChunkTask {
    para: usize,
    chunk: usize,
}

/// The lazily-matched runner fleet: `min(jobs, tasks)` runners constructed
/// EAGERLY before dispatch (the first doubles as the planning cap probe),
/// checked out per chunk task and checked back in after the predict. A
/// checkout blocks while the fleet is exhausted — never constructs beyond
/// the budget, so `make_runner` fires at most `jobs` times per run.
struct RunnerPool<R> {
    idle: Mutex<Vec<R>>,
    available: Condvar,
}

impl<R> RunnerPool<R> {
    /// Seed with the eagerly-constructed fleet.
    fn seeded(fleet: Vec<R>) -> Self {
        Self {
            idle: Mutex::new(fleet),
            available: Condvar::new(),
        }
    }

    /// Take an idle runner, blocking until one is available.
    fn checkout(&self) -> R {
        let mut idle = self.idle.lock().expect("runner pool mutex");
        loop {
            if let Some(runner) = idle.pop() {
                return runner;
            }
            idle = self
                .available
                .wait(idle)
                .expect("runner pool mutex poisoned");
        }
    }

    /// Return a runner and wake one waiter.
    fn checkin(&self, runner: R) {
        self.idle.lock().expect("runner pool mutex").push(runner);
        self.available.notify_one();
    }
}

/// Synthesize every paragraph across all chapters of `bundle`, handing each
/// finished segment to `sink` **by value** — the streaming shape. See the
/// [module docs](self#the-shared-runner-pool) for the scheduling model; the
/// contract below is unchanged from the contiguous-chunk engine:
/// - `voice_id` is the cache-key namespace; `voice_model` is the resolved
///   `.onnx` path on disk.
/// - `make_runner` fires at most `min(jobs, chunk tasks)` times per run (one
///   construction per pool runner — the per-thread cost model).
/// - `encoder` is shared `&E` across all tasks.
/// - `jobs` bounds the pool (clamped to `>= 1`).
/// - aborts on the first paragraph *or sink* error →
///   [`SynthJobError::Synth`] / [`SynthJobError::Sink`]. A paragraph that
///   normalizes to empty fails at the **planning** stage (before any synth
///   happens — no wasted work, no deliveries).
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

    // The first runner doubles as the planning cap probe: it is constructed
    // eagerly (one of the <= jobs constructions — never an extra one) and
    // seeds the fleet. Planning needs the effective engine cap BEFORE any
    // predict could apply it, and this is the one runner that legitimately
    // exists at planning time.
    let probe = make_runner();
    let cap = MAX_SYNTH_CHARS.min(probe.max_synth_chars());

    // Plan every paragraph occurrence up front, in book order, DEDUPING by
    // cache key: each distinct key is synthesized exactly once (identical
    // paragraphs — refrains, boilerplate — used to re-synthesize per
    // occurrence and left collapsing to the sink). Planning mirrors
    // synthesize_paragraph's own key/normalize/split steps over the same
    // crate functions, so planned chunks are byte-identical to what the
    // per-paragraph pipeline would have split (pinned by test).
    let mut planned: Vec<PlannedParagraph> = Vec::with_capacity(paragraphs.len());
    let mut seen_keys: std::collections::HashSet<String> =
        std::collections::HashSet::with_capacity(paragraphs.len());
    for text in &paragraphs {
        let cleaned = normalize_for_speech(text);
        if cleaned.is_empty() {
            return Err(SynthJobError::Synth(SynthError::EmptyText));
        }
        let key = cache_key(voice_id, text);
        if !seen_keys.insert(key.clone()) {
            continue;
        }
        planned.push(PlannedParagraph {
            key,
            chunks: split_for_speech(&cleaned, cap),
            weight: cleaned.chars().count(),
        });
    }

    // LPT (longest-processing-time-first): dispatch paragraphs by normalized
    // char count descending — the classic makespan heuristic for the batch
    // path. Stable sort keeps book order among ties, so jobs=1 runs stay
    // deterministic.
    let mut order: Vec<usize> = (0..planned.len()).collect();
    order.sort_unstable_by(|&a, &b| planned[b].weight.cmp(&planned[a].weight));

    let partials: Vec<PartialParagraph> = planned
        .iter()
        .map(|p| PartialParagraph {
            key: p.key.clone(),
            slots: p.chunks.iter().map(|_| Mutex::new(None)).collect(),
            remaining: AtomicUsize::new(p.chunks.len()),
        })
        .collect();

    // Chunk tasks, paragraph-major in LPT order (chunk order preserved
    // within a paragraph — concat order must be deterministic).
    let tasks: Vec<ChunkTask> = order
        .iter()
        .flat_map(|&para| {
            (0..planned[para].chunks.len()).map(move |chunk| ChunkTask { para, chunk })
        })
        .collect();

    // The eager fleet: min(jobs, tasks) runners, probe included. An empty
    // bundle constructs none.
    let fleet_size = tasks.len().min(jobs);
    let mut fleet = Vec::with_capacity(fleet_size);
    fleet.push(probe);
    for _ in 1..fleet_size {
        fleet.push(make_runner());
    }
    let runner_pool = RunnerPool::seeded(fleet);

    // Progress counter shared across worker threads. Relaxed ordering is
    // enough: each fetch_add yields a unique monotonic index; no other memory
    // needs synchronizing with it.
    // Progress totals the DISTINCT segment count (planned paragraphs), so
    // host percentage rendering needs no change under the dedup pre-pass.
    let total = planned.len();
    let done = AtomicUsize::new(0);

    // Drain the task queue inside our bounded pool: any worker may predict
    // any chunk (work stealing — the fine-grained units that kill the
    // straggler tail), runners come from the shared fleet, and the worker
    // that completes a paragraph assembles and delivers it. Each task checks
    // its runner back in even on the error path (an aborted run must never
    // strand a waiter on a leaked runner). `try_for_each` makes rayon
    // short-circuit on the first error → v1 "abort on first error".
    let run: Result<(), SynthJobError> = pool.install(|| {
        tasks.into_par_iter().try_for_each(|task| {
            let text = &planned[task.para].chunks[task.chunk];
            let predicted = {
                let mut runner = runner_pool.checkout();
                let result = runner.predict(voice_model, text);
                runner_pool.checkin(runner);
                result
            };
            let wav = predicted.map_err(SynthJobError::Synth)?;

            let partial = &partials[task.para];
            {
                let mut slot = partial.slots[task.chunk]
                    .lock()
                    .expect("chunk slot mutex unpoisoned");
                *slot = Some(wav);
            }
            if partial.remaining.fetch_sub(1, Ordering::SeqCst) != 1 {
                return Ok(());
            }

            // Last chunk in: assemble this paragraph's segment. All slots
            // are filled (the countdown hit zero), so the takes cannot miss.
            let wavs: Vec<Vec<u8>> = partial
                .slots
                .iter()
                .map(|s| {
                    s.lock()
                        .expect("chunk slot mutex unpoisoned")
                        .take()
                        .expect("every chunk present when the countdown hits zero")
                })
                .collect();
            let merged = concat_wav(&wavs);
            let audio = encoder.encode(&merged).map_err(SynthJobError::Synth)?;
            let seg = AudioSegment {
                key: partial.key.clone(),
                codec: encoder.codec(),
                bytes: audio,
            };
            if let Some(p) = progress {
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                p.synth_step(n, total);
            }
            sink.deliver(partial.key.clone(), seg)
                .map_err(SynthJobError::Sink)?;
            Ok(())
        })
    });

    run
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
/// - `make_runner` fires at most `min(jobs, chunk tasks)` times per run (one
///   construction per fleet runner — the per-thread cost model
///   model-loaded runners (sherpa) need). Production passes a closure
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
        cache_key, normalize_for_speech, split_for_speech, AudioCodec, AudioMeta, BookBundle,
        BookMeta, ChapterText, Generator, Manifest, ManifestKind, WavPassthrough, MAX_SYNTH_CHARS,
        NORM_VERSION,
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

    /// A runner that records every predicted chunk text with the thread it
    /// ran on — the observability seam for the scheduling tests (LPT order,
    /// work stealing).
    struct SchedulingRecorder {
        predicts: std::sync::Arc<std::sync::Mutex<Vec<(String, std::thread::ThreadId)>>>,
        cap: usize,
    }

    impl PiperRunner for SchedulingRecorder {
        fn predict(&mut self, _voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
            self.predicts
                .lock()
                .unwrap()
                .push((text.to_string(), std::thread::current().id()));
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }

        fn max_synth_chars(&self) -> usize {
            self.cap
        }
    }

    /// A text-only bundle from paragraph strings (chapter-count sentinel).
    fn paragraphs_bundle(paragraphs: &[&str]) -> BookBundle {
        text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            paragraphs.iter().map(|p| (*p).to_string()).collect(),
        )])
    }

    #[test]
    fn chunks_of_one_long_paragraph_span_multiple_workers() {
        // Work-stealing proof (task 002): one very long paragraph (many
        // sentence chunks) at jobs=2 must have its chunks predicted by ≥ 2
        // distinct workers — the fine-grained units that kill the straggler
        // tail. Under the old contiguous-chunk engine a paragraph belonged
        // to exactly one worker.
        let long = "Alpha beta gamma delta epsilon zeta. ".repeat(40);
        let bundle = paragraphs_bundle(&[&long]);

        let predicts: std::sync::Arc<std::sync::Mutex<Vec<(String, std::thread::ThreadId)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = predicts.clone();
        let (sink, deliveries) = RecordingSink::new().into_sink();

        synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            move || SchedulingRecorder {
                predicts: seen.clone(),
                cap: 60,
            },
            &WavPassthrough,
            2,
            None,
            &sink,
        )
        .expect("stub runner succeeds");

        assert_eq!(deliveries.lock().unwrap().len(), 1, "one paragraph");
        let records = predicts.lock().unwrap();
        assert!(
            records.len() > 10,
            "fixture must split into many chunks (got {})",
            records.len()
        );
        let threads: std::collections::HashSet<_> = records.iter().map(|(_, t)| *t).collect();
        assert!(
            threads.len() >= 2,
            "the long paragraph's chunks must span ≥ 2 workers, got {} ({} chunks)",
            threads.len(),
            records.len()
        );
    }

    #[test]
    fn lpt_dispatches_the_longest_paragraph_before_shorter_ones() {
        // LPT (task 002): at jobs=1 the queue is drained in dispatch order,
        // so the longest paragraph's chunks must be predicted before any
        // shorter paragraph's chunks, and the shortest paragraph's chunk
        // must come last.
        let long = format!(
            "{} ",
            "The longest paragraph tells a long tale. ".repeat(20)
        );
        let medium = "A medium paragraph tells a shorter tale. ".repeat(3);
        let short = "Tiny.";
        let bundle = paragraphs_bundle(&[short, long.as_str(), medium.as_str()]);

        let predicts: std::sync::Arc<std::sync::Mutex<Vec<(String, std::thread::ThreadId)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = predicts.clone();
        let (sink, _) = RecordingSink::new().into_sink();

        synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            move || SchedulingRecorder {
                predicts: seen.clone(),
                cap: MAX_SYNTH_CHARS,
            },
            &WavPassthrough,
            1,
            None,
            &sink,
        )
        .expect("stub runner succeeds");

        let records = predicts.lock().unwrap();
        let first = &records.first().expect("at least one predict").0;
        assert!(
            first.starts_with("The longest"),
            "the longest paragraph must be dispatched first, got {first:?}"
        );
        let last = &records.last().expect("records").0;
        assert_eq!(
            last, "Tiny.",
            "the shortest paragraph must be dispatched last"
        );
    }

    #[test]
    fn planned_chunks_match_the_runner_cap_exactly() {
        // Parity pin: the engine's upfront planning must split with the same
        // cap the engine would apply per-paragraph (min(MAX_SYNTH_CHARS,
        // runner cap)) — predicted chunk texts equal split_for_speech of the
        // normalized paragraph under that cap, byte for byte.
        let paragraphs = vec![
            "Short one.".to_string(),
            format!("{} ", "Capped runner splits this. ".repeat(30)),
        ];
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            paragraphs.clone(),
        )]);
        let cap = 42;

        let predicts: std::sync::Arc<std::sync::Mutex<Vec<(String, std::thread::ThreadId)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = predicts.clone();
        let (sink, _) = RecordingSink::new().into_sink();

        synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            move || SchedulingRecorder {
                predicts: seen.clone(),
                cap,
            },
            &WavPassthrough,
            2,
            None,
            &sink,
        )
        .expect("stub runner succeeds");

        let records = predicts.lock().unwrap();
        let predicted: Vec<&str> = records.iter().map(|(t, _)| t.as_str()).collect();
        let expected: Vec<String> = paragraphs
            .iter()
            .flat_map(|p| split_for_speech(&normalize_for_speech(p), MAX_SYNTH_CHARS.min(cap)))
            .collect();
        // LPT reorders paragraphs — compare as multisets of chunk texts.
        let mut predicted_owned: Vec<String> = predicted.iter().map(|s| (*s).to_string()).collect();
        let mut expected_sorted = expected.clone();
        predicted_owned.sort();
        expected_sorted.sort();
        assert_eq!(
            predicted_owned, expected_sorted,
            "planned chunks must equal the cap'd split of every paragraph"
        );
    }

    #[test]
    fn cancelled_predict_unwinds_the_pool_as_typed_cancelled() {
        // Cancel granularity is per chunk (task 002): a runner raising the
        // cooperative Cancelled error aborts the run with the same typed
        // error the hosts map to "Cancelled".
        struct CancelAfterOne;
        impl PiperRunner for CancelAfterOne {
            fn predict(&mut self, _m: &Path, _t: &str) -> Result<Vec<u8>, SynthError> {
                Err(SynthError::Cancelled)
            }
        }
        let bundle = paragraphs_bundle(&["One.", "Two.", "Three."]);
        let (sink, deliveries) = RecordingSink::new().into_sink();

        let err = synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || CancelAfterOne,
            &WavPassthrough,
            2,
            None,
            &sink,
        )
        .expect_err("cancelled must abort");
        assert!(
            matches!(err, SynthJobError::Synth(SynthError::Cancelled)),
            "expected Synth(Cancelled), got {err:?}"
        );
        assert!(deliveries.lock().unwrap().is_empty());
    }

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

        fn into_sink(self) -> (SegmentSink<'static>, Deliveries) {
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
    fn sink_engine_delivers_each_distinct_key_exactly_once() {
        // Dedup pre-pass (task 003): the engine synthesizes each distinct
        // cache key once — two identical paragraphs produce ONE delivery
        // (previously one per occurrence, with the sink left to collapse).
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
        assert_eq!(
            seen.len(),
            2,
            "one delivery per DISTINCT key (dupes pre-collapsed by the engine)"
        );
        let repeat_key = cache_key("v", "Repeat me.");
        let unique_key = cache_key("v", "Unique.");
        assert_eq!(
            seen.iter().filter(|(k, _)| *k == repeat_key).count(),
            1,
            "the repeated paragraph delivers once"
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
    fn duplicates_synthesize_one_predict_set_per_distinct_chunk_set() {
        // The predict-level proof: [A, B, A, A] with a recording runner →
        // predicts exactly == A's chunks + B's chunks (A's set once, not
        // three times), whatever the cap splits them into.
        let a = format!("{} ", "The repeated paragraph says this. ".repeat(20));
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec![a.clone(), "Tiny one.".into(), a.clone(), a.clone()],
        )]);

        let predicts: std::sync::Arc<std::sync::Mutex<Vec<(String, std::thread::ThreadId)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = predicts.clone();
        let (sink, deliveries) = RecordingSink::new().into_sink();

        synth_paragraphs_into(
            &bundle,
            "v",
            Path::new("/dev/null"),
            move || SchedulingRecorder {
                predicts: seen.clone(),
                cap: 60,
            },
            &WavPassthrough,
            2,
            None,
            &sink,
        )
        .expect("stub runner succeeds");

        let a_chunks = split_for_speech(&normalize_for_speech(&a), 60).len();
        let records = predicts.lock().unwrap();
        assert_eq!(
            records.len(),
            a_chunks + 1,
            "A's chunk set once ({a_chunks}) + B's single chunk"
        );
        assert_eq!(deliveries.lock().unwrap().len(), 2, "one delivery per key");
    }

    #[test]
    fn progress_total_is_the_distinct_segment_count() {
        // Progress semantics (task 003): total = distinct keys, so hosts'
        // percentage rendering stays correct with no change. [A, B, A] →
        // two synth steps over total 2.
        let bundle = text_only_bundle(vec![ChapterText::new(
            "bk_test",
            0,
            "Ch",
            vec!["One.".into(), "Two.".into(), "One.".into()],
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
            1, // deterministic step order
            Some(&progress),
            &sink,
        )
        .expect("synth succeeds");

        assert_eq!(captured.take(), "synth [1/2] 50%\nsynth [2/2] 100%\n");
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
