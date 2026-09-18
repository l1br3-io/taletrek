//! The `bench-synth` harness: convert a document through the real synth
//! engine and print a timing report — the baseline instrument for the
//! `progressive-synth` effort (task 001).
//!
//! Measurement rides decorator seams around the pipeline's existing
//! injection points, so the normal path is untouched:
//! - [`BenchRunner`] wraps the production runner and times every
//!   [`PiperRunner::predict`] call (the per-chunk sample set). It also reads
//!   the returned WAV's duration, so total audio seconds — the RTF numerator
//!   — needs no separate accounting.
//! - [`BenchEncoder`] wraps the production encoder and times every
//!   [`Encoder::encode`] call (the synth/encode split's denominator side).
//! - Per-**paragraph** attribution rides a thread-local accumulator: a
//!   paragraph's predicts and its sink delivery all happen on one pool
//!   worker thread, so the runner adds elapsed time to the thread's current
//!   paragraph and the [`SegmentSink`] closure closes it out.
//!
//! # Two-pass protocol
//!
//! Since the fine-grained scheduling rework (progressive-synth task 002), a
//! paragraph's chunks may be predicted by **different** workers — the
//! thread-local close is then only exact at `jobs=1`. [`run_bench_cmd`]
//! therefore runs two passes: the requested `--jobs` pass supplies wall /
//! RTF / audio / delivery counts, and (when `jobs > 1`) a `jobs=1` profile
//! pass supplies the per-paragraph and per-chunk distributions plus the
//! synth/encode split — the intrinsic, scheduling-independent cost profile.
//! [`run_bench`] itself is single-pass; its `paragraphs` field is exact only
//! at `jobs=1` (documented there).
//!
//! [`run_bench`] drives [`taletrek_worker::synth_paragraphs_into`] — the
//! same pool engine the batch pipeline stamps through — with stub runners in
//! tests and the real sherpa/piper engines from the CLI. The report itself
//! ([`render_report`]) is pure over [`BenchStats`], so its math
//! ([`percentile`], RTF, tail ratio) is unit-pinned.

use std::cell::Cell;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use taletrek_synth::pcm::wav_duration;
use taletrek_synth::synth::{PiperRunner, SynthError};
use taletrek_synth::{AudioCodec, BookBundle, Encoder};
use taletrek_worker::{
    default_cache_dir, resolve_voice, Progress, ProgressSink, ResolveOpts, SegmentSink,
    SynthJobError, UreqVoiceSource, DEFAULT_VOICE_ID,
};

use crate::cli::BenchArgs;
use crate::engine::{effective_jobs, DesktopEncoder, DesktopRunner, RunnerSpec};

/// One bench run's aggregate measurements. All durations are wall-clock sums
/// except `audio_total`, which is synthesized-audio playback time (the RTF
/// numerator).
#[derive(Debug, Clone)]
pub struct BenchStats {
    /// Wall time of the whole pool run (all jobs, start → drain).
    pub wall: Duration,
    /// Per-paragraph predict time, one sample per delivered paragraph
    /// occurrence (a paragraph = the sum of its chunks' predict times).
    pub paragraphs: Vec<Duration>,
    /// Per-chunk predict time — one sample per [`PiperRunner::predict`]
    /// call. This is the granularity phase 1's fine-grained scheduling
    /// changes.
    pub chunks: Vec<Duration>,
    /// Sum of all predict time across worker threads (can exceed `wall`
    /// under parallelism).
    pub predict_total: Duration,
    /// Sum of all encode time across worker threads.
    pub encode_total: Duration,
    /// Total synthesized audio playback time (sum of per-chunk WAV
    /// durations).
    pub audio_total: Duration,
    /// Number of segment deliveries (paragraph occurrences, dupes
    /// included — the engine delivers every occurrence).
    pub deliveries: usize,
}

/// Run-configuration rows printed alongside the measurements.
#[derive(Debug, Clone)]
pub struct BenchMeta {
    /// Display path of the benchmarked document.
    pub doc: String,
    /// Voice id the run synthesized with.
    pub voice: String,
    /// Pool size (`--jobs`).
    pub jobs: usize,
    /// Engine label (e.g. `sherpa (in-process)`).
    pub engine: String,
}

/// Run one bench pass over `bundle`'s paragraphs through the real pool
/// engine, returning the aggregated [`BenchStats`].
///
/// `make_runner` and `encoder` are the production seams (the CLI passes the
/// desktop engine selection; tests pass stubs) — both are wrapped in the
/// timing decorators here, never at the call site.
///
/// Per-paragraph attribution is exact only at `jobs=1` (see the module's
/// two-pass note); the caller merges a sequential profile pass for the
/// paragraph rows when benchmarking parallel jobs.
#[allow(clippy::missing_panics_doc)] // poisoned bench mutex = a recorder bug; panicking is correct
pub fn run_bench<R, E, F>(
    bundle: &BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    progress: Option<&dyn ProgressSink>,
) -> Result<BenchStats, SynthJobError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    let shared = Arc::new(Mutex::new(BenchShared::default()));

    // The closing sink: every delivery closes this thread's current
    // paragraph into the shared sample set (the engine delivers on the same
    // worker thread that ran the paragraph's predicts).
    let closing = Arc::clone(&shared);
    let sink = SegmentSink::new(move |_key, _seg| {
        CURRENT_PARAGRAPH.with(|c| {
            let closed = c.replace(Duration::ZERO);
            let mut shared = closing.lock().expect("bench shared mutex");
            shared.paragraphs.push(closed);
            shared.deliveries += 1;
        });
        Ok(())
    });

    let bench_encoder = BenchEncoder {
        inner: encoder,
        shared: Arc::clone(&shared),
    };
    let factory_shared = Arc::clone(&shared);
    let factory = move || BenchRunner {
        inner: make_runner(),
        shared: Arc::clone(&factory_shared),
    };

    let start = Instant::now();
    taletrek_worker::synth_paragraphs_into(
        bundle,
        voice_id,
        voice_model,
        factory,
        &bench_encoder,
        jobs,
        progress,
        &sink,
    )?;
    let wall = start.elapsed();

    drop(sink);
    drop(bench_encoder);
    let recorded = Arc::try_unwrap(shared)
        .expect("bench recorders dropped after the run")
        .into_inner()
        .expect("bench shared mutex");
    Ok(BenchStats {
        wall,
        paragraphs: recorded.paragraphs,
        chunks: recorded.chunks,
        predict_total: recorded.predict_total,
        encode_total: recorded.encode_total,
        audio_total: Duration::from_secs_f64(recorded.audio_total),
        deliveries: recorded.deliveries,
    })
}

/// Nearest-rank percentile of `samples` at `q` (0.0–1.0). `samples` need not
/// be sorted; an empty set yields `Duration::ZERO`.
#[must_use]
pub fn percentile(mut samples: Vec<Duration>, q: f64) -> Duration {
    if samples.is_empty() {
        return Duration::ZERO;
    }
    samples.sort_unstable();
    // Nearest-rank: the smallest sample whose cumulative share reaches q
    // (1-based rank ceil(q * n), clamped into range).
    let rank = (q * samples.len() as f64)
        .ceil()
        .clamp(1.0, samples.len() as f64);
    samples[rank as usize - 1]
}

/// Render the bench report as a markdown document: a settings table, a
/// measurements table (wall, splits, RTF — with the parallel pass's own
/// predict sum for makespan-efficiency math), and the paragraph/chunk
/// percentile rows (p50/p95/max, from the intrinsic profile) plus the tail
/// ratio.
///
/// `profile` supplies the per-paragraph/per-chunk distributions and the
/// intrinsic predict/encode split; `None` means `main` already ran at
/// `jobs=1` and doubles as its own profile.
#[must_use]
pub fn render_report(main: &BenchStats, profile: Option<&BenchStats>, meta: &BenchMeta) -> String {
    let profile = profile.unwrap_or(main);
    let p50 = percentile(profile.paragraphs.clone(), 0.50);
    let p95 = percentile(profile.paragraphs.clone(), 0.95);
    let max = profile.paragraphs.iter().max().copied().unwrap_or_default();
    let tail = if p50.is_zero() {
        0.0
    } else {
        max.as_secs_f64() / p50.as_secs_f64()
    };
    let rtf = if main.wall.is_zero() {
        0.0
    } else {
        main.audio_total.as_secs_f64() / main.wall.as_secs_f64()
    };
    format!(
        concat!(
            "# bench-synth — {doc}\n\n",
            "| setting | value |\n| --- | --- |\n",
            "| engine | {engine} |\n| voice | {voice} |\n| jobs | {jobs} |\n",
            "| paragraphs | {deliveries} |\n| chunks | {chunks} |\n\n",
            "| metric | value |\n| --- | --- |\n",
            "| wall | {wall} |\n| parallel predict Σ | {ppredict} |\n",
            "| predict total (jobs=1) | {predict} |\n",
            "| encode total (jobs=1) | {encode} |\n",
            "| audio total | {audio} |\n| sustained RTF | {rtf:.1}x |\n\n",
            "| predict durations (jobs=1) | p50 | p95 | max |\n| --- | --- | --- | --- |\n",
            "| per paragraph | {p50} | {p95} | {pmax} |\n",
            "| per chunk | {cp50} | {cp95} | {cmax} |\n",
            "| tail (paragraph max/p50) | {tail:.1}x | | |\n"
        ),
        doc = meta.doc,
        engine = meta.engine,
        voice = meta.voice,
        jobs = meta.jobs,
        deliveries = main.deliveries,
        chunks = profile.chunks.len(),
        wall = fmt_duration(main.wall),
        ppredict = fmt_duration(main.predict_total),
        predict = fmt_duration(profile.predict_total),
        encode = fmt_duration(profile.encode_total),
        audio = fmt_duration(main.audio_total),
        rtf = rtf,
        p50 = fmt_duration(p50),
        p95 = fmt_duration(p95),
        pmax = fmt_duration(max),
        cp50 = fmt_duration(percentile(profile.chunks.clone(), 0.50)),
        cp95 = fmt_duration(percentile(profile.chunks.clone(), 0.95)),
        cmax = fmt_duration(profile.chunks.iter().max().copied().unwrap_or_default()),
        tail = tail,
    )
}

/// One-decimal duration: `ms` under a second, `s` at or above.
fn fmt_duration(d: Duration) -> String {
    if d < Duration::from_secs(1) {
        format!("{:.1}ms", d.as_secs_f64() * 1000.0)
    } else {
        format!("{:.1}s", d.as_secs_f64())
    }
}

/// The mutable recorder shared by the decorators and the closing sink.
#[derive(Debug, Default)]
struct BenchShared {
    chunks: Vec<Duration>,
    predict_total: Duration,
    encode_total: Duration,
    audio_total: f64,
    paragraphs: Vec<Duration>,
    deliveries: usize,
}

thread_local! {
    /// Predict time accumulated for the paragraph currently being
    /// synthesized on *this* thread. Closed into `BenchShared::paragraphs`
    /// by the sink delivery, which the engine issues on the same thread.
    static CURRENT_PARAGRAPH: Cell<Duration> = const { Cell::new(Duration::ZERO) };
}

/// Timing decorator around the production [`PiperRunner`].
struct BenchRunner<R> {
    inner: R,
    shared: Arc<Mutex<BenchShared>>,
}

impl<R: PiperRunner> PiperRunner for BenchRunner<R> {
    fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
        let start = Instant::now();
        let wav = self.inner.predict(voice_model, text)?;
        let elapsed = start.elapsed();
        {
            let mut shared = self.shared.lock().expect("bench shared mutex");
            shared.chunks.push(elapsed);
            shared.predict_total += elapsed;
            shared.audio_total += wav_duration(&wav);
        }
        CURRENT_PARAGRAPH.with(|c| c.set(c.get() + elapsed));
        Ok(wav)
    }

    /// Forward the inner engine's cap: split planning asks the outermost
    /// runner, and a decorator that swallowed it would benchmark 400-char
    /// chunks while production runs 120 (the wrapper-forwarding bug this
    /// harness itself uncovered on `DesktopRunner`).
    fn max_synth_chars(&self) -> usize {
        self.inner.max_synth_chars()
    }
}

/// Timing decorator around the production [`Encoder`].
struct BenchEncoder<'e, E> {
    inner: &'e E,
    shared: Arc<Mutex<BenchShared>>,
}

impl<E: Encoder> Encoder for BenchEncoder<'_, E> {
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError> {
        let start = Instant::now();
        let out = self.inner.encode(wav)?;
        let elapsed = start.elapsed();
        self.shared.lock().expect("bench shared mutex").encode_total += elapsed;
        Ok(out)
    }

    fn codec(&self) -> AudioCodec {
        self.inner.codec()
    }
}

/// `bench-synth` subcommand handler: parse/load the input, resolve the voice,
/// run one bench pass through the real engines, and print the report to
/// stdout. Mirrors `run_synth`'s front half (engine selection, input
/// dispatch, voice resolution) so the benchmarked path is the production
/// one; the back half swaps the streaming bundle write for the measuring
/// sink.
pub fn run_bench_cmd(args: BenchArgs) -> Result<()> {
    let progress = Progress::to_stderr();
    let runner_spec = RunnerSpec::select(args.piper.as_deref())?;
    let encoder = DesktopEncoder::select(args.ffmpeg.as_deref())?;
    let jobs = effective_jobs(args.jobs, &runner_spec);

    let voice_id = args
        .voice
        .clone()
        .unwrap_or_else(|| DEFAULT_VOICE_ID.to_string());
    let bundle = crate::load_synth_input(&args.input, &voice_id)?;

    let cache_dir = default_cache_dir().context(
        "no platform cache directory discovered (set $HOME or pass --voice-path to use a local model)",
    )?;
    let opts = ResolveOpts::new(args.voice_path.clone(), cache_dir);
    let voice_model = resolve_voice(Some(&voice_id), &opts, &UreqVoiceSource, Some(&progress))
        .context("resolving voice model")?;

    let engine = engine_label(&runner_spec).to_string();
    let profile_spec = runner_spec.clone();
    let factory_voice_model = voice_model.clone();
    let profile_voice_model = voice_model.clone();
    let profile_factory_model = profile_voice_model.clone();
    let main = run_bench(
        &bundle,
        &voice_id,
        &voice_model,
        move || DesktopRunner::new(runner_spec.clone(), &factory_voice_model),
        &encoder,
        jobs,
        Some(&progress),
    )?;

    // Intrinsic profile: at jobs > 1 a paragraph's chunks may span workers,
    // so the per-paragraph rows (and the split totals) come from an exact
    // sequential pass. Wall / RTF / audio / deliveries stay from the
    // parallel pass above.
    let profile = if jobs > 1 {
        Some(run_bench(
            &bundle,
            &voice_id,
            &profile_voice_model,
            move || DesktopRunner::new(profile_spec.clone(), &profile_factory_model),
            &encoder,
            1,
            None,
        )?)
    } else {
        None
    };

    let meta = BenchMeta {
        doc: args.input.display().to_string(),
        voice: voice_id,
        jobs,
        engine,
    };
    print!("{}", render_report(&main, profile.as_ref(), &meta));
    Ok(())
}

/// Human label for the selected runner (report setting row).
fn engine_label(spec: &RunnerSpec) -> &'static str {
    if spec.is_native() {
        "sherpa (in-process)"
    } else {
        "piper (subprocess)"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;

    use taletrek_synth::synth::PiperRunner;
    use taletrek_synth::{
        normalize_for_speech, split_for_speech, AudioMeta, BookMeta, ChapterText, Generator,
        Manifest, ManifestKind, WavPassthrough, MAX_SYNTH_CHARS,
    };

    /// Canonical mono 16-bit 16 kHz WAV wrapping `pcm` — the shape Piper
    /// emits on stdout and `wav_duration` parses.
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

    /// In-process runner: a fixed canonical WAV regardless of input (4 PCM
    /// bytes = 0.25 ms of audio at 16 kHz — known, so totals are checkable).
    struct StubRunner;

    impl PiperRunner for StubRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    /// Build a minimal text-only bundle carrying the given chapters
    /// (sentinel manifest fields, mirroring the worker's test helper).
    fn text_only_bundle(paragraphs: Vec<String>) -> BookBundle {
        BookBundle {
            manifest: Manifest {
                schema_version: 1,
                kind: ManifestKind::Book,
                book: BookMeta {
                    id: "bk_bench".into(),
                    title: "Bench Book".into(),
                    author: None,
                    source_format: "txt".into(),
                    chapter_count: 1,
                    voice_id: "v".into(),
                    created_at: 0,
                    updated_at: 0,
                    progress_fraction: None,
                },
                audio: AudioMeta {
                    present: false,
                    codec: AudioCodec::Opus,
                    norm_version: taletrek_synth::NORM_VERSION.parse().unwrap(),
                    segment_count: 0,
                },
                generator: Generator {
                    app: "taletrek-desktop".into(),
                    version: "0.1.0".into(),
                },
            },
            chapters: vec![ChapterText::new("bk_bench", 0, "Ch", paragraphs)],
            audio: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn percentile_is_nearest_rank_on_sorted_samples() {
        // Nearest-rank: p50 of [1..=100] (ms) = 50ms, p95 = 95ms, max = 100ms.
        let samples: Vec<Duration> = (1..=100).map(Duration::from_millis).collect();
        assert_eq!(percentile(samples.clone(), 0.50), Duration::from_millis(50));
        assert_eq!(percentile(samples.clone(), 0.95), Duration::from_millis(95));
        assert_eq!(percentile(samples.clone(), 1.0), Duration::from_millis(100));
        // Unsorted input sorts internally.
        let shuffled = vec![
            Duration::from_millis(30),
            Duration::from_millis(10),
            Duration::from_millis(20),
        ];
        assert_eq!(percentile(shuffled, 0.5), Duration::from_millis(20));
    }

    #[test]
    fn percentile_of_empty_is_zero() {
        assert_eq!(percentile(Vec::new(), 0.5), Duration::ZERO);
    }

    #[test]
    fn bench_runner_forwards_the_inner_engine_chunk_cap() {
        // The decorator must not swallow the engine's cap — split planning
        // asks the outermost runner (the wrapper-forwarding bug class).
        struct CappedRunner;
        impl PiperRunner for CappedRunner {
            fn predict(&mut self, _m: &Path, _t: &str) -> Result<Vec<u8>, SynthError> {
                Ok(canonical_wav(&[0x01]))
            }
            fn max_synth_chars(&self) -> usize {
                42
            }
        }
        let shared = Arc::new(Mutex::new(BenchShared::default()));
        let runner = BenchRunner {
            inner: CappedRunner,
            shared,
        };
        assert_eq!(runner.max_synth_chars(), 42);
    }

    #[test]
    fn run_bench_attributes_one_paragraph_per_delivery_at_jobs_one() {
        // 5 paragraphs (one duplicated, one long enough to split into
        // multiple chunks), sequential: the thread-local close is exact at
        // jobs=1 — one paragraph sample per delivery, chunk count equals
        // the pipeline's own split planning, and the paragraph samples sum
        // to predict_total exactly. The engine's dedup pre-pass skips the
        // duplicate occurrence, so deliveries/chunks count DISTINCT keys.
        let long = "Alpha beta gamma delta. ".repeat(60);
        let paragraphs = vec![
            "Short one.".to_string(),
            long.clone(),
            "Short two.".to_string(),
            "Short one.".to_string(),
            "Short three.".to_string(),
        ];
        let distinct: Vec<&String> = vec![
            &paragraphs[0],
            &paragraphs[1],
            &paragraphs[2],
            &paragraphs[4],
        ];
        let bundle = text_only_bundle(paragraphs.clone());

        let stats = run_bench(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
        )
        .expect("stub bench run succeeds");

        assert_eq!(
            stats.deliveries, 4,
            "one delivery per DISTINCT paragraph key"
        );
        assert_eq!(
            stats.paragraphs.len(),
            4,
            "sequential close must yield one paragraph sample per delivery"
        );
        let sum: Duration = stats.paragraphs.iter().sum();
        assert_eq!(sum, stats.predict_total);
        let expected_chunks: usize = distinct
            .iter()
            .map(|p| split_for_speech(&normalize_for_speech(p), MAX_SYNTH_CHARS).len())
            .sum();
        assert!(
            expected_chunks > 4,
            "fixture must contain a split paragraph"
        );
        assert_eq!(
            stats.chunks.len(),
            expected_chunks,
            "one chunk sample per predict call over distinct keys"
        );
        let expected_audio = expected_chunks as f64 * 2.0 / 16_000.0;
        assert!(
            (stats.audio_total.as_secs_f64() - expected_audio).abs() < 1e-9,
            "audio total {} ~ {expected_audio}",
            stats.audio_total.as_secs_f64()
        );
    }

    #[test]
    fn run_bench_parallel_pass_keeps_scheduling_free_invariants() {
        // At jobs=2 chunks may span workers, so only the scheduling-free
        // facts hold: distinct delivery count, chunk count, audio total
        // (per-predict accounting). The per-paragraph rows come from the
        // jobs=1 profile pass in run_bench_cmd (two-pass protocol).
        let long = "Alpha beta gamma delta. ".repeat(60);
        let paragraphs = vec![
            "Short one.".to_string(),
            long.clone(),
            "Short two.".to_string(),
            "Short one.".to_string(),
            "Short three.".to_string(),
        ];
        let distinct: Vec<&String> = vec![
            &paragraphs[0],
            &paragraphs[1],
            &paragraphs[2],
            &paragraphs[4],
        ];
        let bundle = text_only_bundle(paragraphs.clone());

        let stats = run_bench(
            &bundle,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
            None,
        )
        .expect("stub bench run succeeds");

        assert_eq!(stats.deliveries, 4);
        let expected_chunks: usize = distinct
            .iter()
            .map(|p| split_for_speech(&normalize_for_speech(p), MAX_SYNTH_CHARS).len())
            .sum();
        assert_eq!(stats.chunks.len(), expected_chunks);
        let expected_audio = expected_chunks as f64 * 2.0 / 16_000.0;
        assert!(
            (stats.audio_total.as_secs_f64() - expected_audio).abs() < 1e-9,
            "per-predict audio accounting is worker-agnostic"
        );
    }

    #[test]
    fn render_report_contains_settings_measurements_and_tail() {
        let main = BenchStats {
            wall: Duration::from_secs(10),
            paragraphs: vec![Duration::from_millis(1); 3],
            chunks: vec![Duration::from_millis(1); 3],
            predict_total: Duration::from_secs(5),
            encode_total: Duration::from_millis(900),
            audio_total: Duration::from_secs(100),
            deliveries: 3,
        };
        // A jobs=1 profile: the paragraph distribution [1,2,3]s drives the
        // percentile + tail rows.
        let profile = BenchStats {
            wall: Duration::from_secs(30),
            paragraphs: vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(3),
            ],
            chunks: vec![Duration::from_secs(2); 3],
            predict_total: Duration::from_secs(6),
            encode_total: Duration::from_secs(1),
            audio_total: Duration::from_secs(100),
            deliveries: 3,
        };
        let meta = BenchMeta {
            doc: "novel.epub".into(),
            voice: "en_US-hfc_female-medium".into(),
            jobs: 2,
            engine: "sherpa (in-process)".into(),
        };
        let report = render_report(&main, Some(&profile), &meta);
        assert!(report.contains("novel.epub"), "names the doc");
        assert!(
            report.contains("en_US-hfc_female-medium"),
            "names the voice"
        );
        assert!(report.contains("sherpa (in-process)"), "names the engine");
        assert!(
            report.contains("10.0s"),
            "wall time rendered from main pass"
        );
        assert!(
            report.contains("5.0s"),
            "parallel predict sum rendered from main pass"
        );
        assert!(report.contains("RTF"), "sustained RTF present");
        assert!(
            report.contains("10.0x"),
            "RTF 100s audio / 10s wall = 10.0x"
        );
        assert!(report.contains("p50"), "percentile rows present");
        assert!(report.contains("p95"), "percentile rows present");
        // p50 of [1,2,3]s = 2s, max = 3s → tail ratio 1.5x (profile rows).
        assert!(report.contains("1.5x"), "tail max/p50 ratio rendered");
        // jobs=1 invocation: main doubles as its own profile.
        let single = render_report(&profile, None, &meta);
        assert!(
            single.contains("30.0s"),
            "profile-less render uses main for wall"
        );
        assert!(single.contains("1.5x"), "tail from main-as-profile");
    }
}
