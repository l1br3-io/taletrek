//! Parallel synth engine: synthesize every paragraph of a bundle's chapters
//! into content-addressed audio segments using a bounded `rayon` pool.
//!
//! This module is pure orchestration — all synth logic (normalize → split →
//! Piper → concat → encode) lives in [`taletrek_synth::synthesize_paragraph`].
//! The engine here:
//! - flattens every chapter's paragraphs into one work list,
//! - runs them through a `rayon` thread pool sized by `--jobs`,
//! - constructs a **fresh** [`taletrek_synth::PiperRunner`] per task (each task
//!   owns its own `&mut R`; the runner can't be shared across threads), and
//! - shares a single `&E` [`taletrek_synth::Encoder`] by reference
//!   (`encode(&self)` is stateless).
//!
//! On the first paragraph that errors, the whole run aborts (rayon short-
//! circuits `collect::<Result<..>>`). Continue-on-error (`--keep-going`) is a
//! follow-up; v1 aborts.
//!
//! `dead_code` was lifted in T2.4: `synth_all_paragraphs` + `SynthJobError` are
//! now reached via `bundle_io::synth_and_stamp` → `run_synth`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use rayon::prelude::*;
use thiserror::Error;

use taletrek_synth::synth::{synthesize_paragraph, PiperRunner, SynthError, SynthOptions};
use taletrek_synth::{AudioSegment, BookBundle, Encoder};

use taletrek_worker::{Progress, ProgressSink};

/// All the ways a parallel synth run can fail. Typed so the host (T2.4
/// `bundle_io`) can branch and so `?` lifts cleanly into `anyhow` at the CLI
/// boundary.
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

/// Synthesize every paragraph across all chapters of `bundle` into a
/// content-addressed `HashMap<cache_key, AudioSegment>`.
///
/// - `voice_id` is the cache-key namespace (and ends up in the manifest's
///   `book.voiceId`); `voice_model` is the resolved `.onnx` path on disk.
/// - `make_runner` is called once **per paragraph** to produce a fresh runner
///   owned by that task. Production passes a closure capturing the piper binary
///   path; tests pass a closure returning a stub runner.
/// - `encoder` is shared by `&E` across all tasks (`encode(&self)` is
///   stateless), matching the spec's "one shared `OpusEncoder`" decision.
/// - `jobs` bounds the pool (clamped to `>= 1`). The default `num_cpus` is
///   resolved by the caller.
///
/// Aborts on the first paragraph error (rayon short-circuits
/// `collect::<Result>`) → [`SynthJobError::Synth`]. Identical paragraphs dedup
/// into one segment (content addressing), matching how the SPA's audio cache
/// behaves.
///
/// `progress`, when `Some`, emits a `synth [done/total] pct%` line to stderr
/// after each successful paragraph. Under parallelism the `done` counter is
/// monotonic but lines may interleave out of strict order; tests pin `jobs: 1`
/// for deterministic ordering. `None` is silent.
pub fn synth_all_paragraphs<R, E, F>(
    bundle: &BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    progress: Option<&Progress>,
) -> Result<HashMap<String, AudioSegment>, SynthJobError>
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

    // Run the parallel map inside our bounded pool. Each task constructs a
    // fresh runner (owned locally — `&mut R` can't cross threads) and borrows
    // the shared `&E` encoder by ref. `collect::<Result<Vec<_>, _>>` makes
    // rayon short-circuit on the first error → v1 "abort on first error".
    // `.inspect` reports synth progress after each successful paragraph.
    let segments: Result<Vec<(String, AudioSegment)>, SynthError> = pool.install(|| {
        paragraphs
            .par_iter()
            .map(|text| {
                let mut runner = make_runner();
                let mut opts = SynthOptions::new(voice_model, &mut runner, encoder);
                let out = synthesize_paragraph(voice_id, text, &mut opts)?;
                let key = out.cache_key.clone();
                let seg = AudioSegment {
                    key: out.cache_key,
                    codec: out.codec,
                    bytes: out.audio,
                };
                Ok((key, seg))
            })
            .inspect(|res| {
                if let Some(p) = progress {
                    if res.is_ok() {
                        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                        p.synth_step(n, total);
                    }
                }
            })
            .collect()
    });

    Ok(segments?.into_iter().collect())
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
