//! [`PipelineHandle`] — the convert pipeline as a UniFFI object.
//!
//! Thin over [`taletrek_worker::PipelineJob`]: the handle owns a snapshot
//! state (poll-friendly), spawns the job on a plain worker thread (Android
//! hosts it inside its foreground service; iOS inside a Task — the object is
//! thread-agnostic), and forwards events to a [`PipelineObserver`] callback
//! interface. Every decision stays in the kernel — the wrappers only
//! flatten types and forward calls.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use taletrek_worker::{PipelineEvent, PipelineJob, PipelineOutcome, PipelineSpec, PipelineVariant};

/// One convert job's configuration. Paths are absolute host dirs — the
/// kernel never resolves platform defaults.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiPipelineConfig {
    /// Path to the source document (the host has already copied its content
    /// URI into a cache file it owns; parse wants bytes anyway).
    pub source_path: String,
    /// Source filename when known — title fallback + format hint.
    pub hint: Option<String>,
    /// `true` = text-only bundle (no voice needed); `false` = full synth
    /// (or progressive, when [`Self::progressive`] is set).
    pub text_only: bool,
    /// Curated voice id; `None` = the curated default.
    pub voice_id: Option<String>,
    /// Voice cache dir (e.g. `<filesDir>/voices`).
    pub voice_cache_dir: String,
    /// The espeak-ng-data dir (e.g. `<filesDir>/espeak-ng-data` — see
    /// `ensure_espeak_data`); only read when actually synthesizing.
    pub espeak_dir: String,
    /// Output dir (the library scan root, e.g. `<filesDir>/books`).
    pub books_dir: String,
    /// Synth pool size (2 on mobile).
    pub jobs: u32,
    /// `generator.app` identity (e.g. `taletrek-android`).
    pub generator_app: String,
    /// Progressive conversion (text bundle lands immediately, synth
    /// streams into the segment store, drain seals a full bundle).
    /// `None` = the batch behavior above; ignored when `text_only`.
    pub progressive: Option<FfiProgressiveConfig>,
}

/// Progressive-specific pipeline configuration.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiProgressiveConfig {
    /// Segment store root (e.g. `<cacheDir>/taletrek/segments`) — shared
    /// across books and runs; the resume source.
    pub store_dir: String,
    /// Where synthesis aims first: the reader's stored resume position.
    /// `None` = book start. Movable live via
    /// [`PipelineHandle::set_anchor`].
    pub initial_anchor: Option<FfiAnchor>,
}

/// A playback position the scheduler aims audio production at — chapter and
/// paragraph indices into the book (the identity the kernel reader's
/// positions reduce to).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct FfiAnchor {
    /// Chapter index into the bundle's chapter list.
    pub chapter: u32,
    /// Paragraph index within that chapter.
    pub paragraph: u32,
}

/// What a successful run produced.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FfiPipelineOutcome {
    /// The deterministic content-derived book id.
    pub book_id: String,
    /// Absolute path of the written bundle.
    pub bundle_path: String,
    /// `true` when the text-only variant ran.
    pub text_only: bool,
    /// Chapter count.
    pub chapters: u32,
    /// Paragraph count across chapters.
    pub paragraphs: u32,
    /// Distinct audio segments (0 for text-only).
    pub segments: u32,
    /// `true` when the progressive variant sealed (text bundle replaced by
    /// the full one). Always `false` for text-only/full.
    pub sealed: bool,
}

/// The handle's snapshot state — poll-friendly mirror of the run. The same
/// information arrives as the run's end; hosts pick whichever mechanism
/// suits (events are the primary channel per task 002's verdict).
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum FfiPipelineState {
    /// Constructed, not started.
    Idle,
    /// Running (no error, no outcome yet).
    Running,
    /// Finished: the outcome of a successful run.
    Finished(FfiPipelineOutcome),
    /// Failed: a stable error kind + human message.
    Failed {
        /// Stable kind string (`parse`, `unknown_format`, `resolve`,
        /// `stamp`, `write`) for UI branching.
        kind: String,
        /// Human-readable message (the kernel error's Display).
        message: String,
    },
    /// Cancelled by the host. No partial bundle exists.
    Cancelled,
}

/// Pipeline lifecycle phases, mirrored for the foreign side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FfiPipelinePhase {
    /// Detecting format + parsing.
    Parsing,
    /// Resolving/downloading the voice.
    ResolvingVoice,
    /// Synthesizing.
    Synthesizing,
    /// Writing the bundle.
    Writing,
    /// Merging store segments into the final full bundle (progressive
    /// only): the queue drained, the book is sealing.
    Sealing,
}

/// Events streamed to [`PipelineObserver`].
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Enum)]
pub enum FfiPipelineEvent {
    /// A phase was entered.
    Phase(FfiPipelinePhase),
    /// Parsing finished: the book's shape.
    Parsed {
        /// Chapter count.
        chapters: u32,
        /// Paragraph count.
        paragraphs: u32,
    },
    /// Voice download progress (`bytes_total == 0` = unknown length).
    DownloadStep {
        /// Bytes fetched so far.
        bytes_done: u64,
        /// Total bytes, or 0 when unknown.
        bytes_total: u64,
    },
    /// Synth progress.
    SynthStep {
        /// Paragraphs completed.
        done: u32,
        /// Total paragraphs.
        total: u32,
    },
    /// Progressive only: ≥ 30 s of audio exists at the anchor — surface
    /// "start listening" while synthesis continues.
    Playable,
    /// Progressive only: the sealed full bundle atomically replaced the
    /// text-only one; the job finishes immediately after.
    Sealed,
}

/// Consumer of pipeline events.
///
/// **Threading contract (task 002 verdict — callbacks, not polling):**
/// events arrive on the worker thread running the job, including rayon
/// pool threads during synthesis. Kotlin implementations must dispatch to
/// the main thread themselves (e.g. `Handler(Looper.getMainLooper()).post`);
/// Swift runtimes hop via `DispatchQueue.main`. Polling
/// [`PipelineHandle::state`] is the sanctioned fallback for hosts that
/// can't take background callbacks.
#[uniffi::export(callback_interface)]
pub trait PipelineObserver: Send + Sync {
    /// One pipeline event.
    fn on_pipeline_event(&self, event: FfiPipelineEvent);
}

/// A lazily-constructed sherpa runner: the resolved voice model path isn't
/// known when the spec is built (resolution happens inside the job), but
/// [`taletrek_synth::PiperRunner::predict`] receives it on every call — so
/// the runner loads the model on first predict and reuses it after (the
/// desktop `DesktopRunner` pattern, one load per pool-chunk runner).
struct LazySherpaRunner {
    espeak_dir: PathBuf,
    inner: Option<taletrek_synth::SherpaRunner>,
}

impl LazySherpaRunner {
    fn new(espeak_dir: PathBuf) -> Self {
        Self {
            espeak_dir,
            inner: None,
        }
    }
}

impl taletrek_synth::PiperRunner for LazySherpaRunner {
    fn predict(
        &mut self,
        voice_model: &std::path::Path,
        text: &str,
    ) -> Result<Vec<u8>, taletrek_synth::SynthError> {
        if self.inner.is_none() {
            self.inner = Some(taletrek_synth::SherpaRunner::with_espeak_data(
                voice_model,
                &self.espeak_dir,
            )?);
        }
        self.inner
            .as_mut()
            .expect("inner constructed above")
            .predict(voice_model, text)
    }

    /// Forward the sherpa arena bound — split planning asks before the lazy
    /// inner runner exists.
    fn max_synth_chars(&self) -> usize {
        taletrek_synth::SHERPA_MAX_SYNTH_CHARS
    }
}

/// The convert job as an object: `new(config)` → `start(observer)` →
/// events → terminal `state()`. `cancel()` is safe at any point; jobs are
/// one-shot per handle.
#[derive(uniffi::Object)]
pub struct PipelineHandle {
    config: FfiPipelineConfig,
    state: Mutex<FfiPipelineState>,
    job: Mutex<Option<Arc<PipelineJob>>>,
}

/// Setup failures before the job can start (bad config paths, double
/// start).
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum FfiPipelineSetupError {
    /// The source document couldn't be read (missing, unreadable).
    #[error("reading source {path}: {detail}")]
    ReadSource {
        /// The path that failed.
        path: String,
        /// The underlying failure.
        detail: String,
    },
    /// `start` was called twice on one handle (jobs are one-shot).
    #[error("pipeline already started")]
    AlreadyStarted,
}

fn error_kind(err: &taletrek_worker::PipelineError) -> &'static str {
    match err {
        taletrek_worker::PipelineError::Parse(_) => "parse",
        taletrek_worker::PipelineError::UnknownFormat { .. } => "unknown_format",
        taletrek_worker::PipelineError::Resolve(_) => "resolve",
        taletrek_worker::PipelineError::Espeak(_) => "espeak",
        taletrek_worker::PipelineError::Stamp(_) => "stamp",
        taletrek_worker::PipelineError::Store(_) => "store",
        taletrek_worker::PipelineError::Cancelled => "cancelled",
        taletrek_worker::PipelineError::Write { .. } => "write",
    }
}

fn outcome_record(outcome: &PipelineOutcome) -> FfiPipelineOutcome {
    FfiPipelineOutcome {
        book_id: outcome.book_id.clone(),
        bundle_path: outcome.bundle_path.display().to_string(),
        text_only: outcome.text_only,
        chapters: u32::try_from(outcome.chapters).unwrap_or(u32::MAX),
        paragraphs: u32::try_from(outcome.paragraphs).unwrap_or(u32::MAX),
        segments: u32::try_from(outcome.segments).unwrap_or(u32::MAX),
        sealed: outcome.sealed,
    }
}

/// Adapter: worker events → observer callback.
struct ObserverReporter(Box<dyn PipelineObserver>);

impl taletrek_worker::PipelineReporter for ObserverReporter {
    fn pipeline_event(&self, event: PipelineEvent) {
        let event = match event {
            PipelineEvent::Phase(taletrek_worker::PipelinePhase::Parsing) => {
                FfiPipelineEvent::Phase(FfiPipelinePhase::Parsing)
            }
            PipelineEvent::Phase(taletrek_worker::PipelinePhase::ResolvingVoice) => {
                FfiPipelineEvent::Phase(FfiPipelinePhase::ResolvingVoice)
            }
            PipelineEvent::Phase(taletrek_worker::PipelinePhase::Synthesizing) => {
                FfiPipelineEvent::Phase(FfiPipelinePhase::Synthesizing)
            }
            PipelineEvent::Phase(taletrek_worker::PipelinePhase::Writing) => {
                FfiPipelineEvent::Phase(FfiPipelinePhase::Writing)
            }
            PipelineEvent::Phase(taletrek_worker::PipelinePhase::Sealing) => {
                FfiPipelineEvent::Phase(FfiPipelinePhase::Sealing)
            }
            PipelineEvent::Playable => FfiPipelineEvent::Playable,
            PipelineEvent::Sealed => FfiPipelineEvent::Sealed,
            PipelineEvent::Parsed {
                chapters,
                paragraphs,
            } => FfiPipelineEvent::Parsed {
                chapters: u32::try_from(chapters).unwrap_or(u32::MAX),
                paragraphs: u32::try_from(paragraphs).unwrap_or(u32::MAX),
            },
            PipelineEvent::DownloadStep {
                bytes_done,
                bytes_total,
            } => FfiPipelineEvent::DownloadStep {
                bytes_done,
                bytes_total,
            },
            PipelineEvent::SynthStep { done, total } => FfiPipelineEvent::SynthStep {
                done: u32::try_from(done).unwrap_or(u32::MAX),
                total: u32::try_from(total).unwrap_or(u32::MAX),
            },
        };
        self.0.on_pipeline_event(event);
    }
}

impl PipelineHandle {
    /// Build the worker spec from the config. The runner factory is
    /// injectable so host tests stub the engine; production constructs the
    /// lazy sherpa runner.
    fn spec_from(
        config: &FfiPipelineConfig,
        make_runner: taletrek_worker::RunnerFactory,
    ) -> Result<PipelineSpec, FfiPipelineSetupError> {
        let source =
            std::fs::read(&config.source_path).map_err(|e| FfiPipelineSetupError::ReadSource {
                path: config.source_path.clone(),
                detail: e.to_string(),
            })?;
        let variant = if config.text_only {
            PipelineVariant::TextOnly {
                voice_id: config.voice_id.clone(),
            }
        } else if let Some(progressive) = &config.progressive {
            PipelineVariant::Progressive {
                voice_id: config.voice_id.clone(),
                store_dir: PathBuf::from(&progressive.store_dir),
            }
        } else {
            PipelineVariant::Full {
                voice_id: config.voice_id.clone(),
            }
        };
        let initial_anchor = config
            .progressive
            .as_ref()
            .and_then(|p| p.initial_anchor)
            .map(|a| taletrek_worker::ProgressiveAnchor {
                chapter: a.chapter,
                paragraph: a.paragraph,
            });
        Ok(PipelineSpec {
            source,
            hint: config.hint.clone(),
            variant,
            generator_app: config.generator_app.clone(),
            jobs: config.jobs.max(1) as usize,
            resolve: taletrek_worker::ResolveOpts::new(
                None,
                PathBuf::from(&config.voice_cache_dir),
            ),
            espeak_root: PathBuf::from(&config.espeak_dir)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
            books_dir: PathBuf::from(&config.books_dir),
            make_runner,
            encoder: Arc::new(taletrek_synth::NativeOpusEncoder::new()),
            initial_anchor,
        })
    }

    /// `start` with an injectable runner factory — the test seam beneath
    /// the UniFFI surface.
    fn start_with_factory(
        self: Arc<Self>,
        observer: Box<dyn PipelineObserver>,
        make_runner: taletrek_worker::RunnerFactory,
    ) -> Result<(), FfiPipelineSetupError> {
        let spec = Self::spec_from(&self.config, make_runner)?;
        let mut slot = self.job.lock().expect("job lock");
        if slot.is_some() {
            return Err(FfiPipelineSetupError::AlreadyStarted);
        }
        let job = Arc::new(PipelineJob::new(spec));
        *slot = Some(Arc::clone(&job));
        drop(slot);
        *self.state.lock().expect("state lock") = FfiPipelineState::Running;

        let handle = Arc::clone(&self);
        std::thread::spawn(move || {
            let reporter = ObserverReporter(observer);
            let result = job.run_shared(&taletrek_worker::UreqVoiceSource, Some(&reporter));
            let next = match result {
                Ok(outcome) => FfiPipelineState::Finished(outcome_record(&outcome)),
                Err(taletrek_worker::PipelineError::Cancelled) => FfiPipelineState::Cancelled,
                Err(e) => FfiPipelineState::Failed {
                    kind: error_kind(&e).to_string(),
                    message: e.to_string(),
                },
            };
            *handle.state.lock().expect("state lock") = next;
        });
        Ok(())
    }
}

/// Production runner factory: a lazy sherpa runner per pool chunk.
fn sherpa_factory(espeak_dir: &str) -> taletrek_worker::RunnerFactory {
    let espeak_dir = PathBuf::from(espeak_dir);
    Arc::new(move || {
        Box::new(LazySherpaRunner::new(espeak_dir.clone()))
            as Box<dyn taletrek_synth::PiperRunner + Send>
    })
}

#[uniffi::export]
impl PipelineHandle {
    /// Create a handle for `config`. Nothing runs until [`start`](Self::start).
    #[uniffi::constructor]
    pub fn new(config: FfiPipelineConfig) -> Self {
        Self {
            config,
            state: Mutex::new(FfiPipelineState::Idle),
            job: Mutex::new(None),
        }
    }

    /// Start the job on a worker thread; events stream to `observer` and
    /// the terminal state lands in [`state`](Self::state). Errors if
    /// already started (one-shot handle) or the source is unreadable.
    pub fn start(
        self: Arc<Self>,
        observer: Box<dyn PipelineObserver>,
    ) -> Result<(), FfiPipelineSetupError> {
        let factory = sherpa_factory(&self.config.espeak_dir);
        self.start_with_factory(observer, factory)
    }

    /// Request cancellation; the terminal state becomes `Cancelled` (unless
    /// the job already finished). Safe at any time.
    pub fn cancel(&self) {
        if let Some(job) = self.job.lock().expect("job lock").as_ref() {
            job.cancel();
        }
    }

    /// Move the scheduling anchor (progressive only): synthesis re-aims at
    /// the new position — the horizon near it becomes the priority tier.
    /// In-flight chunks finish (cancellation is the only preemption). A
    /// no-op before [`start`](Self::start) (set `initial_anchor` on the
    /// config instead) and for non-progressive jobs.
    pub fn set_anchor(&self, anchor: FfiAnchor) {
        if let Some(job) = self.job.lock().expect("job lock").as_ref() {
            job.set_anchor(taletrek_worker::ProgressiveAnchor {
                chapter: anchor.chapter,
                paragraph: anchor.paragraph,
            });
        }
    }

    /// Snapshot state (poll-friendly; the terminal state mirrors the run's
    /// end).
    pub fn state(&self) -> FfiPipelineState {
        self.state.lock().expect("state lock").clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;
    use std::time::Duration;

    use taletrek_synth::PiperRunner;

    struct StubRunner;

    impl PiperRunner for StubRunner {
        fn predict(
            &mut self,
            _voice_model: &Path,
            _text: &str,
        ) -> Result<Vec<u8>, taletrek_synth::SynthError> {
            Ok(canonical_wav())
        }
    }

    fn canonical_wav() -> Vec<u8> {
        let pcm = [0x01u8, 0x02, 0x03, 0x04];
        let data_len = pcm.len() as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&32_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend_from_slice(&pcm);
        wav
    }

    fn stub_factory() -> taletrek_worker::RunnerFactory {
        Arc::new(|| Box::new(StubRunner) as Box<dyn PiperRunner + Send>)
    }

    fn config(dir: &Path, text_only: bool) -> FfiPipelineConfig {
        let source = dir.join("source.txt");
        std::fs::write(&source, b"chapter one\n\nalpha beta\n\ngamma delta").unwrap();
        // Pre-seed the espeak marker (config.espeak_dir = <dir>/espeak-ng-data
        // ⇒ espeak_root = <dir>): the full variant's ensure short-circuits and
        // the real UreqVoiceSource stays offline in tests.
        let espeak = dir.join("espeak-ng-data");
        std::fs::create_dir_all(&espeak).unwrap();
        std::fs::write(espeak.join("en_dict"), b"marker").unwrap();
        FfiPipelineConfig {
            source_path: source.display().to_string(),
            hint: Some("source.txt".to_string()),
            text_only,
            voice_id: None,
            voice_cache_dir: dir.join("voices").display().to_string(),
            espeak_dir: dir.join("espeak-ng-data").display().to_string(),
            books_dir: dir.join("books").display().to_string(),
            jobs: 1,
            generator_app: "taletrek-ffi-test".to_string(),
            progressive: None,
        }
    }

    /// Seed the default voice cache files so `resolve_voice` short-circuits
    /// offline (both `.onnx` + `.json` present = cache hit).
    fn seed_voice_cache(dir: &Path) {
        let voices = dir.join("voices");
        std::fs::create_dir_all(&voices).unwrap();
        let id = taletrek_worker::DEFAULT_VOICE_ID;
        std::fs::write(voices.join(format!("{id}.onnx")), b"model").unwrap();
        std::fs::write(voices.join(format!("{id}.json")), b"{}").unwrap();
    }

    #[derive(Default)]
    struct RecordingObserver {
        events: Mutex<Vec<FfiPipelineEvent>>,
    }

    impl PipelineObserver for RecordingObserver {
        fn on_pipeline_event(&self, event: FfiPipelineEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    fn wait_for_terminal(handle: &PipelineHandle) -> FfiPipelineState {
        for _ in 0..300 {
            if !matches!(
                handle.state(),
                FfiPipelineState::Running | FfiPipelineState::Idle
            ) {
                return handle.state();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "pipeline did not finish within 6s; state = {:?}",
            handle.state()
        );
    }

    #[test]
    fn full_run_round_trips_through_the_handle() {
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());

        let handle = Arc::new(PipelineHandle::new(config(dir.path(), false)));
        let observer = Arc::new(RecordingObserver::default());
        Arc::clone(&handle)
            .start_with_factory(Box::new(ArcObserver(Arc::clone(&observer))), stub_factory())
            .expect("start");

        let state = wait_for_terminal(&handle);
        let FfiPipelineState::Finished(outcome) = state else {
            panic!("expected Finished, got {state:?}");
        };
        assert!(!outcome.text_only);
        assert_eq!(outcome.chapters, 1);
        assert_eq!(outcome.paragraphs, 2);
        assert_eq!(outcome.segments, 2);
        let bundle_path = PathBuf::from(&outcome.bundle_path);
        assert!(bundle_path.is_file());
        let bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&bundle_path).unwrap()).unwrap();
        assert!(bundle.manifest.audio.present);
        assert_eq!(bundle.manifest.generator.app, "taletrek-ffi-test");

        let events = observer.events.lock().unwrap().clone();
        assert!(events.contains(&FfiPipelineEvent::Phase(FfiPipelinePhase::Parsing)));
        assert!(
            events.contains(&FfiPipelineEvent::Phase(FfiPipelinePhase::Synthesizing)),
            "events = {events:?}"
        );
        assert!(events.contains(&FfiPipelineEvent::Parsed {
            chapters: 1,
            paragraphs: 2
        }));
    }

    #[test]
    fn text_only_run_writes_a_text_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let handle = Arc::new(PipelineHandle::new(config(dir.path(), true)));
        let observer = Arc::new(RecordingObserver::default());
        Arc::clone(&handle)
            .start_with_factory(Box::new(ArcObserver(Arc::clone(&observer))), stub_factory())
            .expect("start");
        let state = wait_for_terminal(&handle);
        let FfiPipelineState::Finished(outcome) = state else {
            panic!("expected Finished, got {state:?}");
        };
        assert!(outcome.text_only);
        assert_eq!(outcome.segments, 0);
        assert!(!observer
            .events
            .lock()
            .unwrap()
            .contains(&FfiPipelineEvent::Phase(FfiPipelinePhase::Synthesizing)));
    }

    #[test]
    fn cancel_surfaces_typed_state_and_start_is_one_shot() {
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());
        let handle = Arc::new(PipelineHandle::new(config(dir.path(), false)));
        Arc::clone(&handle)
            .start_with_factory(
                Box::new(ArcObserver(Arc::new(RecordingObserver::default()))),
                stub_factory(),
            )
            .expect("start");
        handle.cancel();
        let state = wait_for_terminal(&handle);
        match state {
            FfiPipelineState::Cancelled => {
                let books = dir.path().join("books");
                if books.is_dir() {
                    let leftovers: Vec<_> = std::fs::read_dir(&books)
                        .unwrap()
                        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                        .collect();
                    assert!(
                        leftovers.is_empty(),
                        "cancelled run left artifacts: {leftovers:?}"
                    );
                }
            }
            FfiPipelineState::Finished(_) => { /* raced to completion — fine */ }
            other => panic!("expected Cancelled or Finished, got {other:?}"),
        }

        let again = handle.start_with_factory(
            Box::new(ArcObserver(Arc::new(RecordingObserver::default()))),
            stub_factory(),
        );
        assert!(matches!(again, Err(FfiPipelineSetupError::AlreadyStarted)));
    }

    #[test]
    fn unreadable_source_errors_typed_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(dir.path(), true);
        cfg.source_path = dir.path().join("missing.txt").display().to_string();
        let handle = Arc::new(PipelineHandle::new(cfg));
        let result = Arc::clone(&handle).start_with_factory(
            Box::new(ArcObserver(Arc::new(RecordingObserver::default()))),
            stub_factory(),
        );
        assert!(matches!(
            result,
            Err(FfiPipelineSetupError::ReadSource { .. })
        ));
        assert_eq!(handle.state(), FfiPipelineState::Idle);
    }

    #[test]
    fn spec_from_pins_espeak_root_at_the_config_espeak_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path(), false);
        let spec = PipelineHandle::spec_from(&cfg, stub_factory()).unwrap();
        assert_eq!(
            spec.espeak_root,
            dir.path(),
            "espeak_root must be config.espeak_dir's parent"
        );
        // The kernel ensures <espeak_root>/espeak-ng-data — pin that this is
        // exactly the dir the runner receives, so the ensure path and the
        // LazySherpaRunner path can never disagree.
        assert_eq!(
            spec.espeak_root.join("espeak-ng-data"),
            PathBuf::from(&cfg.espeak_dir)
        );
    }

    #[test]
    fn lazy_sherpa_runner_forwards_the_sherpa_chunk_cap_pre_construction() {
        // The arena bound is a locked spec decision (120 chars): the lazy
        // wrapper must advertise it before the inner runner exists, or split
        // planning feeds 400-char chunks and the ORT arena snaps to its
        // high-water mark (the LMK crash class). Found by the bench-synth
        // baseline (progressive-synth task 001).
        let runner = LazySherpaRunner::new(std::path::PathBuf::from("/nonexistent"));
        assert!(
            runner.inner.is_none(),
            "cap must be answerable without constructing the engine"
        );
        assert_eq!(
            runner.max_synth_chars(),
            taletrek_synth::SHERPA_MAX_SYNTH_CHARS
        );
    }

    #[test]
    fn espeak_failure_surfaces_typed_espeak_kind_through_the_handle() {
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());
        let mut cfg = config(dir.path(), false);
        // A regular file where the espeak root must live: the marker check
        // can't traverse it and create_dir_all errors — a deterministic,
        // offline espeak failure through the real handle thread.
        let blocker = dir.path().join("espeak-root-is-a-file");
        std::fs::write(&blocker, b"not a dir").unwrap();
        cfg.espeak_dir = blocker.join("espeak-ng-data").display().to_string();

        let handle = Arc::new(PipelineHandle::new(cfg));
        Arc::clone(&handle)
            .start_with_factory(
                Box::new(ArcObserver(Arc::new(RecordingObserver::default()))),
                stub_factory(),
            )
            .expect("start");

        let state = wait_for_terminal(&handle);
        match state {
            FfiPipelineState::Failed { kind, message } => {
                assert_eq!(kind, "espeak", "message was: {message}");
            }
            other => panic!("expected Failed(espeak), got {other:?}"),
        }
    }

    /// `Arc<RecordingObserver>` forwarder so tests can observe after the
    /// `Box<dyn PipelineObserver>` crosses into `start`.
    struct ArcObserver(Arc<RecordingObserver>);

    impl PipelineObserver for ArcObserver {
        fn on_pipeline_event(&self, event: FfiPipelineEvent) {
            self.0.on_pipeline_event(event);
        }
    }

    // ---- progressive surface (progressive-synth task 008) ----

    /// The store-registration tests mutate a process global — serialize
    /// them against each other (std Mutex guard, no new deps).
    static STORE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A slow stub: 31 s of PCM per segment with a 10 ms predict delay —
    /// long enough to trip PLAYABLE_SECONDS, slow enough for the test to
    /// catch the text bundle mid-run.
    struct LongSlowRunner;

    impl PiperRunner for LongSlowRunner {
        fn predict(
            &mut self,
            _voice_model: &Path,
            _text: &str,
        ) -> Result<Vec<u8>, taletrek_synth::SynthError> {
            std::thread::sleep(Duration::from_millis(30));
            let secs = 31.0_f64;
            let pcm_len = (16_000.0 * 2.0 * secs) as u32;
            let mut wav = canonical_wav();
            wav.truncate(36);
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&pcm_len.to_le_bytes());
            wav.resize(44 + pcm_len as usize, 0x00);
            Ok(wav)
        }
    }

    fn progressive_config(dir: &Path) -> FfiPipelineConfig {
        let mut cfg = config(dir, false);
        cfg.progressive = Some(FfiProgressiveConfig {
            store_dir: dir.join("segments").display().to_string(),
            initial_anchor: None,
        });
        cfg
    }

    #[test]
    fn progressive_run_round_trips_with_playable_and_sealed_events() {
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());

        let handle = Arc::new(PipelineHandle::new(progressive_config(dir.path())));
        let observer = Arc::new(RecordingObserver::default());
        Arc::clone(&handle)
            .start_with_factory(
                Box::new(ArcObserver(Arc::clone(&observer))),
                Arc::new(|| Box::new(LongSlowRunner) as Box<dyn PiperRunner + Send>),
            )
            .expect("start");

        let state = wait_for_terminal(&handle);
        let FfiPipelineState::Finished(outcome) = state else {
            panic!("expected Finished, got {state:?}");
        };
        assert!(outcome.sealed, "outcome = {outcome:?}");
        assert!(!outcome.text_only);
        assert_eq!(outcome.segments, 2);

        let events = observer.events.lock().unwrap().clone();
        let position = |target: FfiPipelineEvent| {
            events
                .iter()
                .position(|e| *e == target)
                .unwrap_or_else(|| panic!("{target:?} missing from {events:?}"))
        };
        let playable = position(FfiPipelineEvent::Playable);
        let sealing = position(FfiPipelineEvent::Phase(FfiPipelinePhase::Sealing));
        let sealed = position(FfiPipelineEvent::Sealed);
        assert!(playable < sealing, "Playable before Sealing: {events:?}");
        assert!(sealing < sealed, "Sealing before Sealed: {events:?}");

        // The sealed bundle opens and reads progressively.
        let bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&outcome.bundle_path).unwrap())
                .unwrap();
        assert!(bundle.manifest.audio.present);
    }

    #[test]
    fn read_segment_progressive_distinguishes_not_ready_ready_and_missing() {
        let _guard = STORE_TEST_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());

        let handle = Arc::new(PipelineHandle::new(progressive_config(dir.path())));
        Arc::clone(&handle)
            .start_with_factory(
                Box::new(ArcObserver(Arc::new(RecordingObserver::default()))),
                Arc::new(|| Box::new(LongSlowRunner) as Box<dyn PiperRunner + Send>),
            )
            .expect("start");

        // Catch the book mid-fill: the text bundle exists before synth
        // completes (progressive text-early). Poll for it.
        let books = dir.path().join("books");
        let mut text_bundle: Option<PathBuf> = None;
        for _ in 0..200 {
            if let Ok(entries) = std::fs::read_dir(&books) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.ends_with(".taletrek") {
                        text_bundle = Some(entry.path());
                        break;
                    }
                }
            }
            if text_bundle.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let bundle_path = text_bundle.expect("text bundle lands before synth completes");
        // While still running: a real key is NotReady, a bogus one Missing.
        let (manifest, chapters) = taletrek_synth::read_book_metadata(&bundle_path).unwrap();
        assert!(!manifest.audio.present, "still filling at catch time");
        let key = taletrek_synth::cache_key(&manifest.book.voice_id, &chapters[0].paragraphs[0]);
        if matches!(handle.state(), FfiPipelineState::Running) {
            assert_eq!(
                crate::read_segment_progressive(bundle_path.display().to_string(), key.clone())
                    .unwrap(),
                crate::FfiSegmentStatus::NotReady,
                "expected key answers NotReady while the book fills"
            );
        }
        assert_eq!(
            crate::read_segment_progressive(
                bundle_path.display().to_string(),
                "voice:1:deadbeef".to_string()
            )
            .unwrap(),
            crate::FfiSegmentStatus::Missing,
            "a key the book never references is Missing"
        );

        wait_for_terminal(&handle);
        // Sealed: the real key is Ready (WAV codec), the bogus one Missing.
        match crate::read_segment_progressive(bundle_path.display().to_string(), key) {
            Ok(crate::FfiSegmentStatus::Ready { bytes, codec }) => {
                // The FFI production path encodes with the native Opus
                // encoder — sealed segments are OGG.
                assert!(bytes.starts_with(b"OggS"));
                assert_eq!(codec, "opus");
            }
            other => panic!("expected Ready after seal, got {other:?}"),
        }
        assert_eq!(
            crate::read_segment_progressive(
                bundle_path.display().to_string(),
                "voice:1:deadbeef".to_string()
            )
            .unwrap(),
            crate::FfiSegmentStatus::Missing
        );
    }

    #[test]
    fn read_segment_progressive_serves_landed_segments_from_a_registered_store() {
        let _guard = STORE_TEST_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());

        // A text-only bundle: the filling book, made deterministically.
        let text_handle = Arc::new(PipelineHandle::new(config(dir.path(), true)));
        let state = {
            let observer = Arc::new(RecordingObserver::default());
            Arc::clone(&text_handle)
                .start_with_factory(Box::new(ArcObserver(Arc::clone(&observer))), stub_factory())
                .expect("start");
            wait_for_terminal(&text_handle)
        };
        let FfiPipelineState::Finished(outcome) = state else {
            panic!("expected Finished, got {state:?}");
        };
        assert!(outcome.text_only);

        let bundle_path = std::path::PathBuf::from(&outcome.bundle_path);
        let (manifest, chapters) = taletrek_synth::read_book_metadata(&bundle_path).unwrap();
        assert!(!manifest.audio.present);
        let key = taletrek_synth::cache_key(&manifest.book.voice_id, &chapters[0].paragraphs[0]);

        // No registered store (and a text-only bundle): expected → NotReady.
        crate::set_segment_store(None);
        assert_eq!(
            crate::read_segment_progressive(bundle_path.display().to_string(), key.clone())
                .unwrap(),
            crate::FfiSegmentStatus::NotReady
        );

        // A registered store holding the key serves it: Ready, verbatim.
        let store_dir = dir.path().join("segments");
        let store = taletrek_worker::store::SegmentStore::open(&store_dir).unwrap();
        store
            .put(&taletrek_synth::bundle::AudioSegment {
                key: key.clone(),
                codec: taletrek_synth::bundle::AudioCodec::Wav,
                bytes: b"RIFF-store".to_vec(),
            })
            .unwrap();
        crate::set_segment_store(Some(store_dir.display().to_string()));
        match crate::read_segment_progressive(bundle_path.display().to_string(), key.clone()) {
            Ok(crate::FfiSegmentStatus::Ready { bytes, codec }) => {
                assert_eq!(bytes, b"RIFF-store");
                assert_eq!(codec, "wav");
            }
            other => panic!("expected Ready from the store, got {other:?}"),
        }

        // A registered store WITHOUT the key is still NotReady — and the
        // registration resets cleanly.
        let empty = dir.path().join("empty-store");
        std::fs::create_dir_all(&empty).unwrap();
        crate::set_segment_store(Some(empty.display().to_string()));
        assert_eq!(
            crate::read_segment_progressive(bundle_path.display().to_string(), key).unwrap(),
            crate::FfiSegmentStatus::NotReady
        );
        crate::set_segment_store(None);
    }

    #[test]
    fn text_only_books_become_playable_when_a_store_is_registered() {
        let _guard = STORE_TEST_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());

        let text_handle = Arc::new(PipelineHandle::new(config(dir.path(), true)));
        let state = {
            let observer = Arc::new(RecordingObserver::default());
            Arc::clone(&text_handle)
                .start_with_factory(Box::new(ArcObserver(Arc::clone(&observer))), stub_factory())
                .expect("start");
            wait_for_terminal(&text_handle)
        };
        let FfiPipelineState::Finished(outcome) = state else {
            panic!("expected Finished, got {state:?}");
        };

        let book = crate::open_book(outcome.bundle_path.clone()).unwrap();
        assert!(!book.audio_present);

        // Without a registered store the sequencer rests: text-only
        // absorbs every event (the desktop-import contract).
        crate::set_segment_store(None);
        let resting = crate::TrekPlayer::new(book.clone());
        assert_eq!(
            resting.tick(crate::FfiPlayerEvent::Play),
            crate::FfiPlayerAction::None
        );

        // A registered store upgrades the book to playable — the store
        // supplies the audio the manifest doesn't (filling books).
        let store_dir = dir.path().join("segments");
        std::fs::create_dir_all(&store_dir).unwrap();
        crate::set_segment_store(Some(store_dir.display().to_string()));
        let playing = crate::TrekPlayer::new(book.clone());
        let expected = book.chapters[0].paragraphs[0].segment_key.clone();
        assert_eq!(
            playing.tick(crate::FfiPlayerEvent::Play),
            crate::FfiPlayerAction::LoadSegment {
                key: expected,
                offset: 0.0
            }
        );

        // The restore constructor upgrades the same way (a filling
        // session resumes where it left off).
        let restored = crate::TrekPlayer::restore(
            book,
            crate::FfiPosition {
                chapter: 0,
                index: 1,
                offset: 0.0,
            },
        );
        assert!(matches!(
            restored.tick(crate::FfiPlayerEvent::Play),
            crate::FfiPlayerAction::LoadSegment { .. }
        ));

        crate::set_segment_store(None);
    }

    #[test]
    fn set_anchor_is_accepted_mid_run_and_ignored_before_start() {
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());
        let handle = Arc::new(PipelineHandle::new(progressive_config(dir.path())));
        // Before start: a no-op, not an error.
        handle.set_anchor(FfiAnchor {
            chapter: 0,
            paragraph: 1,
        });
        Arc::clone(&handle)
            .start_with_factory(
                Box::new(ArcObserver(Arc::new(RecordingObserver::default()))),
                Arc::new(|| Box::new(LongSlowRunner) as Box<dyn PiperRunner + Send>),
            )
            .expect("start");
        // Mid-run: accepted (behavior pinned at the worker level).
        handle.set_anchor(FfiAnchor {
            chapter: 0,
            paragraph: 1,
        });
        let state = wait_for_terminal(&handle);
        assert!(matches!(state, FfiPipelineState::Finished(_)));
    }

    #[test]
    fn batch_read_segment_behaves_exactly_as_before() {
        let dir = tempfile::tempdir().unwrap();
        seed_voice_cache(dir.path());
        let handle = Arc::new(PipelineHandle::new(config(dir.path(), false)));
        Arc::clone(&handle)
            .start_with_factory(
                Box::new(ArcObserver(Arc::new(RecordingObserver::default()))),
                stub_factory(),
            )
            .expect("start");
        let FfiPipelineState::Finished(outcome) = wait_for_terminal(&handle) else {
            panic!("expected Finished");
        };

        let (manifest, chapters) =
            taletrek_synth::read_book_metadata(Path::new(&outcome.bundle_path)).unwrap();
        let key = taletrek_synth::cache_key(&manifest.book.voice_id, &chapters[0].paragraphs[0]);
        // The old read_segment: Some(bytes) for present keys, None for
        // absent — unchanged.
        assert!(crate::read_segment(outcome.bundle_path.clone(), key)
            .unwrap()
            .is_some());
        assert_eq!(
            crate::read_segment(outcome.bundle_path.clone(), "voice:1:deadbeef".to_string())
                .unwrap(),
            None
        );
    }
}
