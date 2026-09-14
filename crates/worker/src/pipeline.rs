//! The host-agnostic convert pipeline: source bytes → stamped `.taletrek`.
//!
//! [`PipelineJob`] composes what the desktop GUI's executor does egui-side
//! into reusable Rust, so Android (and iOS, and eventually the desktop
//! executor itself) drive one object instead of re-implementing
//! orchestration per platform. The discipline is unchanged: every decision
//! (format detection, deterministic ids, chunking, stamping, atomic write)
//! lives here in the kernel; the host owns UI, permissions, and where the
//! object runs.
//!
//! One `run` = parse → deterministic id → text-only bundle → (text-only
//! variant: write | full variant: resolve voice → ensure espeak-ng-data →
//! `synth_and_stamp`) → atomic write to `books_dir/<book_id>.taletrek`.
//! Cancellation is cooperative and per-paragraph ([`CancellableRunner`]
//! checks the flag before every predict; stage boundaries check it too) — a
//! cancelled or failed job never leaves a partial book behind, because the
//! bundle is serialized to a same-dir temp file and renamed into place only
//! when complete.
//!
//! Threading: the job is `Send + 'static`-spawnable but thread-agnostic —
//! the FFI layer decides how to host it. Progress flows through
//! [`PipelineReporter`] (phase transitions + step counts), which the FFI
//! layer adapts into platform callbacks.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use thiserror::Error;

use taletrek_parse::{detect_format, parse_source, SourceFormat};
use taletrek_synth::bundle::manifest::Generator;
use taletrek_synth::synth::{PiperRunner, SynthError};
use taletrek_synth::{write_book_bundle, AudioCodec, BookBundle, Encoder};

use crate::stamp::{synth_and_stamp, StampError};
use crate::synth_job::SynthJobError;
use crate::voices::{
    ensure_espeak_data, resolve_voice, EspeakError, ResolveError, ResolveOpts, VoiceSource,
    DEFAULT_VOICE_ID,
};
use crate::ProgressSink;

/// Shared cooperative-cancel flag (the desktop executor's `CancelFlag`,
/// promoted into the kernel).
pub type CancelFlag = Arc<AtomicBool>;

/// Which flavor of bundle a job produces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineVariant {
    /// Stop after parse: a text-only bundle (reader shows transport
    /// disabled + hint). `voice_id` stamps the manifest's would-be voice —
    /// `None` means the curated default.
    TextOnly {
        /// The voice the manifest advertises (used if this bundle is ever
        /// synthesized later).
        voice_id: Option<String>,
    },
    /// Resolve the voice (injectable source + cache dir), synth every
    /// paragraph, stamp full. `voice_id` `None` = curated default.
    Full {
        /// Curated voice id to resolve and synthesize with.
        voice_id: Option<String>,
    },
}

/// Everything a job needs, supplied by the host. Paths are explicit — the
/// job never calls `default_cache_dir()` (Android's `dirs` resolves nothing
/// over JNI; the host always knows its dirs).
#[derive(Clone)]
pub struct PipelineSpec {
    /// Raw source-document bytes (the host has already copied its content
    /// URI / file into memory or a cache file it reads itself).
    pub source: Vec<u8>,
    /// Source filename when known — metadata fallback (title from stem) and
    /// the extension fallback for format detection.
    pub hint: Option<String>,
    /// Text-only vs full (synthesized) output.
    pub variant: PipelineVariant,
    /// `generator.app` identity stamped into the manifest (e.g.
    /// `taletrek-android`); one stamping path, distinct producer strings.
    pub generator_app: String,
    /// Synth pool size (2 on mobile for thermal sanity; `num_cpus` on
    /// desktop). Ignored by the text-only variant.
    pub jobs: usize,
    /// Voice resolution options — the same seam the desktop uses. The cache
    /// dir must be explicit; the `voice_path` override short-circuits the
    /// catalog (CLI-style power use).
    pub resolve: ResolveOpts,
    /// Root dir for espeak-ng-data acquisition: the ensured dir is
    /// `<espeak_root>/espeak-ng-data` (parent-dir convention — see
    /// [`ensure_espeak_data`]). The full variant ensures it after voice
    /// resolve, before synth, so every host (Android, iOS) is first-run
    /// correct without app-side prerequisite calls. Ignored by the
    /// text-only variant.
    pub espeak_root: PathBuf,
    /// Directory the finished bundle is written into (the library scan
    /// root). The file is `<book_id>.taletrek`.
    pub books_dir: PathBuf,
    /// Factory producing engine runners — called once per pool chunk, so at
    /// most `jobs` times per run. Production (FFI) constructs sherpa
    /// runners; tests construct stubs.
    pub make_runner: RunnerFactory,
    /// Shared encoder for the synth stage (the pool shares it by
    /// reference, so it must be thread-safe).
    pub encoder: Arc<dyn Encoder + Send + Sync>,
}

/// Runner factory: produces one engine runner per pool chunk.
pub type RunnerFactory = Arc<dyn Fn() -> Box<dyn PiperRunner + Send> + Send + Sync>;

/// Lifecycle phases, reported as they're entered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelinePhase {
    /// Detecting format + parsing source bytes.
    Parsing,
    /// Resolving/downloading the voice (full variant only).
    ResolvingVoice,
    /// Synthesizing paragraphs (full variant only).
    Synthesizing,
    /// Serializing + atomically writing the bundle.
    Writing,
}

/// What actually happened in a job, for the host's completion UI.
#[derive(Debug, Clone)]
pub struct PipelineOutcome {
    /// The deterministic content-derived book id (`bk_<16 hex>`).
    pub book_id: String,
    /// Path of the written bundle (`books_dir/<book_id>.taletrek`).
    pub bundle_path: PathBuf,
    /// `true` when the text-only variant ran.
    pub text_only: bool,
    /// Chapter count.
    pub chapters: usize,
    /// Paragraph count across chapters.
    pub paragraphs: usize,
    /// Distinct audio segments (0 for text-only).
    pub segments: usize,
}

/// Progress events a job reports. Phase transitions plus the two step
/// streams (download bytes, synth paragraphs); the host adapts these into
/// whatever UI it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineEvent {
    /// A phase was entered.
    Phase(PipelinePhase),
    /// Parsing finished: the book's shape.
    Parsed {
        /// Chapter count.
        chapters: usize,
        /// Paragraph count across chapters.
        paragraphs: usize,
    },
    /// Voice download progress; `bytes_total == 0` when the source reports
    /// no length.
    DownloadStep {
        /// Bytes fetched so far.
        bytes_done: u64,
        /// Total bytes, or 0 when unknown.
        bytes_total: u64,
    },
    /// Synth progress: `done` of `total` paragraphs complete.
    SynthStep {
        /// Paragraphs completed.
        done: usize,
        /// Total paragraphs.
        total: usize,
    },
}

/// Consumer of [`PipelineEvent`]s. Implemented by hosts (the FFI layer
/// bridges this to platform callbacks); `Send + Sync` because synth steps
/// arrive from pool threads.
pub trait PipelineReporter: Send + Sync {
    /// One pipeline event.
    fn pipeline_event(&self, event: PipelineEvent);
}

/// All the ways a pipeline run can fail. Typed so hosts branch (cancelled ≠
/// failed; unknown format suggests a picker retry; resolve errors suggest a
/// network retry).
#[derive(Debug, Error)]
pub enum PipelineError {
    /// The source document failed to parse.
    #[error(transparent)]
    Parse(#[from] taletrek_parse::ParseError),
    /// Neither content sniffing nor the filename hint recognized a format.
    #[error("unrecognized source format (content signature and hint {:?} both failed)", hint.as_deref().unwrap_or(""))]
    UnknownFormat {
        /// The filename hint that was tried, when present.
        hint: Option<String>,
    },
    /// Voice resolution (catalog lookup / download / override) failed.
    #[error(transparent)]
    Resolve(#[from] ResolveError),
    /// Acquiring espeak-ng-data failed (download, size band, extraction).
    #[error(transparent)]
    Espeak(#[from] EspeakError),
    /// Synthesis or stamping failed (non-cancel).
    #[error(transparent)]
    Stamp(#[from] StampError),
    /// The job was cancelled. No partial bundle exists.
    #[error("cancelled")]
    Cancelled,
    /// Writing the bundle failed (temp write or rename).
    #[error("writing bundle {}: {source}", path.display())]
    Write {
        /// The intended final path.
        path: PathBuf,
        /// The underlying I/O failure.
        #[source]
        source: std::io::Error,
    },
}

/// A [`PiperRunner`] decorator that refuses to infer once its flag is set:
/// `predict` returns [`SynthError::Cancelled`] *before* touching the inner
/// runner, so rayon's abort-on-first-error unwinds the synth pool at the
/// next paragraph boundary (per-paragraph cancel granularity). Ported from
/// the desktop executor — now the one copy.
pub struct CancellableRunner {
    flag: CancelFlag,
    inner: Box<dyn PiperRunner + Send>,
}

impl CancellableRunner {
    /// Wrap `inner` with a cancel flag.
    pub fn new(flag: CancelFlag, inner: Box<dyn PiperRunner + Send>) -> Self {
        Self { flag, inner }
    }
}

impl PiperRunner for CancellableRunner {
    fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
        if self.flag.load(Ordering::Relaxed) {
            return Err(SynthError::Cancelled);
        }
        self.inner.predict(voice_model, text)
    }
}

/// `Arc<dyn Encoder + Send + Sync>` → `&impl Encoder` adapter:
/// `synth_and_stamp` takes a concrete shared encoder by reference, the spec
/// holds a trait object.
struct SharedEncoder(Arc<dyn Encoder + Send + Sync>);

impl Encoder for SharedEncoder {
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError> {
        self.0.encode(wav)
    }

    fn codec(&self) -> AudioCodec {
        self.0.codec()
    }
}

/// `&dyn PipelineReporter` → `&dyn ProgressSink`: forwards the two step
/// streams so `resolve_voice` and `synth_and_stamp` progress rides the same
/// reporter as phase transitions.
struct ReporterAsSink<'a>(&'a dyn PipelineReporter);

impl ProgressSink for ReporterAsSink<'_> {
    fn synth_step(&self, done: usize, total: usize) {
        self.0
            .pipeline_event(PipelineEvent::SynthStep { done, total });
    }

    fn download_step(&self, bytes_done: u64, bytes_total: u64) {
        self.0.pipeline_event(PipelineEvent::DownloadStep {
            bytes_done,
            bytes_total,
        });
    }
}

/// One convert job. Call [`PipelineJob::cancel`] from UI code while `run`
/// executes on a worker; `run` consumes `self`.
pub struct PipelineJob {
    spec: PipelineSpec,
    flag: CancelFlag,
}

impl PipelineJob {
    /// Build a job from a spec.
    pub fn new(spec: PipelineSpec) -> Self {
        Self {
            spec,
            flag: CancelFlag::default(),
        }
    }

    /// Request cancellation. In-flight synthesis unwinds at the next
    /// paragraph boundary; stage boundaries check before every transition.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }

    /// The job's cancel flag, shared with [`PipelineJob::cancel`]. Hosts
    /// may hold it to poll or to wire their own cancellation sources (the
    /// flag is the single source of truth — setting it externally cancels
    /// the job exactly like `cancel`).
    #[must_use]
    pub fn cancel_flag(&self) -> CancelFlag {
        Arc::clone(&self.flag)
    }

    /// Whether cancellation was requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// Execute the job end-to-end. Blocking; host it wherever makes sense
    /// (Android: a foreground-service thread; iOS: a Task). `source` is the
    /// injectable voice source (production: `UreqVoiceSource`; tests:
    /// stubs). `reporter` receives phase + step events when `Some`.
    pub fn run(
        self,
        source: &dyn VoiceSource,
        reporter: Option<&dyn PipelineReporter>,
    ) -> Result<PipelineOutcome, PipelineError> {
        let Self { spec, flag } = self;
        Self::run_parts(spec, flag, source, reporter)
    }

    /// [`PipelineJob::run`] for hosts that hold the job in an `Arc` (the
    /// FFI handle pattern: the worker thread runs a spec clone while the
    /// host keeps cancel access). The cancel flag is shared, so
    /// [`PipelineJob::cancel`] on the original cancels this run.
    pub fn run_shared(
        &self,
        source: &dyn VoiceSource,
        reporter: Option<&dyn PipelineReporter>,
    ) -> Result<PipelineOutcome, PipelineError> {
        Self::run_parts(self.spec.clone(), Arc::clone(&self.flag), source, reporter)
    }

    fn run_parts(
        spec: PipelineSpec,
        flag: CancelFlag,
        source: &dyn VoiceSource,
        reporter: Option<&dyn PipelineReporter>,
    ) -> Result<PipelineOutcome, PipelineError> {
        let sink = reporter.map(ReporterAsSink);
        let sink_ref: Option<&dyn ProgressSink> = sink.as_ref().map(|s| s as &dyn ProgressSink);
        let emit = |event: PipelineEvent| {
            if let Some(r) = reporter {
                r.pipeline_event(event);
            }
        };

        emit(PipelineEvent::Phase(PipelinePhase::Parsing));
        let format = detect_source_format(&spec.source, spec.hint.as_deref()).ok_or_else(|| {
            PipelineError::UnknownFormat {
                hint: spec.hint.clone(),
            }
        })?;
        let book = parse_source(&spec.source, format, spec.hint.as_deref())?;
        let paragraphs: usize = book.chapters.iter().map(|c| c.paragraphs.len()).sum();
        let chapters = book.chapters.len();
        emit(PipelineEvent::Parsed {
            chapters,
            paragraphs,
        });

        // Id is derived and fixed BEFORE bundle build — chapter ids embed it.
        let book_id = taletrek_parse::deterministic_book_id(&book);
        let voice = match &spec.variant {
            PipelineVariant::TextOnly { voice_id } | PipelineVariant::Full { voice_id } => voice_id
                .clone()
                .unwrap_or_else(|| DEFAULT_VOICE_ID.to_string()),
        };
        let text_only = to_text_only(&book, &voice, &spec.generator_app, &book_id);

        let bundle = match spec.variant {
            PipelineVariant::TextOnly { .. } => text_only,
            PipelineVariant::Full { .. } => {
                ensure_not_cancelled(&flag)?;
                emit(PipelineEvent::Phase(PipelinePhase::ResolvingVoice));
                let model = resolve_voice(Some(&voice), &spec.resolve, source, sink_ref)?;

                ensure_not_cancelled(&flag)?;
                ensure_espeak_data(&spec.espeak_root, source, sink_ref)?;

                ensure_not_cancelled(&flag)?;
                emit(PipelineEvent::Phase(PipelinePhase::Synthesizing));
                let cancelled_flag = Arc::clone(&flag);
                let factory = Arc::clone(&spec.make_runner);
                let make_runner =
                    move || CancellableRunner::new(Arc::clone(&cancelled_flag), factory());
                let encoder = SharedEncoder(Arc::clone(&spec.encoder));
                let mut bundle = text_only;
                synth_and_stamp_cancel_aware(
                    &mut bundle,
                    &voice,
                    &model,
                    make_runner,
                    &encoder,
                    spec.jobs,
                    &spec.generator_app,
                    sink_ref,
                )?;
                bundle
            }
        };

        ensure_not_cancelled(&flag)?;
        emit(PipelineEvent::Phase(PipelinePhase::Writing));
        fs::create_dir_all(&spec.books_dir).map_err(|e| PipelineError::Write {
            path: spec.books_dir.clone(),
            source: e,
        })?;
        let bundle_path = spec.books_dir.join(format!("{book_id}.taletrek"));
        write_bundle_atomic(&bundle, &bundle_path)?;

        let segments = bundle.audio.len();
        Ok(PipelineOutcome {
            book_id,
            bundle_path,
            text_only: !bundle.manifest.audio.present,
            chapters,
            paragraphs,
            segments,
        })
    }
}

/// Build the deterministic-id text-only bundle for `book`.
fn to_text_only(
    book: &taletrek_parse::ParsedBook,
    voice: &str,
    generator_app: &str,
    book_id: &str,
) -> BookBundle {
    taletrek_parse::to_text_only_bundle_with_id(book, voice, generator(generator_app), book_id)
}

/// `synth_and_stamp` with cancel-aware error mapping: a cancelled synth
/// surfaces as [`PipelineError::Cancelled`], not a synth failure.
#[allow(clippy::too_many_arguments)] // mirrors synth_and_stamp's signature; see stamp.rs
fn synth_and_stamp_cancel_aware<R, E, F>(
    bundle: &mut BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    generator_app: &str,
    progress: Option<&dyn ProgressSink>,
) -> Result<(), PipelineError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    match synth_and_stamp(
        bundle,
        voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        generator_app,
        progress,
    ) {
        Ok(()) => Ok(()),
        Err(StampError::Synth(SynthJobError::Synth(SynthError::Cancelled))) => {
            Err(PipelineError::Cancelled)
        }
        Err(e) => Err(e.into()),
    }
}

/// Stage-boundary cancel check — raises the typed cancelled error before
/// each transition (post-parse, post-resolve, pre-write).
fn ensure_not_cancelled(flag: &CancelFlag) -> Result<(), PipelineError> {
    if flag.load(Ordering::Relaxed) {
        return Err(PipelineError::Cancelled);
    }
    Ok(())
}

/// Content sniff first (share/intent payloads can be mislabeled or
/// extension-less), filename extension second — mirrors the CLI's map.
fn detect_source_format(bytes: &[u8], hint: Option<&str>) -> Option<SourceFormat> {
    if let Some(format) = detect_format(bytes) {
        return Some(format);
    }
    let ext = hint?.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "epub" => Some(SourceFormat::Epub),
        "txt" => Some(SourceFormat::Txt),
        "html" | "htm" => Some(SourceFormat::Html),
        "md" | "markdown" => Some(SourceFormat::Md),
        "docx" => Some(SourceFormat::Docx),
        "pdf" => Some(SourceFormat::Pdf),
        _ => None,
    }
}

/// Generator identity with a host-supplied app string; version stays
/// "0.0.0" here (the kernel doesn't know host versions — the FFI layer may
/// extend this later without breaking the pipeline contract).
fn generator(app: &str) -> Generator {
    Generator {
        app: app.to_string(),
        version: "0.0.0".to_string(),
    }
}

/// GOTCHA: atomic bundle write — the temp file MUST live in the destination
/// directory (rename across filesystems — e.g. /cache → /data — fails with
/// `EXDEV`), and its name must be unique per attempt so concurrent jobs
/// writing the same book id can't clobber each other's temp. Last complete
/// rename wins, and a failed job's temp is removed, never promoted.
fn write_bundle_atomic(bundle: &BookBundle, path: &Path) -> Result<(), PipelineError> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut buffer = Cursor::new(Vec::new());
    write_book_bundle(bundle, &mut buffer).map_err(StampError::from)?;
    let tmp = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    let write = || -> Result<(), PipelineError> {
        fs::write(&tmp, buffer.get_ref()).map_err(|e| PipelineError::Write {
            path: path.to_path_buf(),
            source: e,
        })?;
        fs::rename(&tmp, path).map_err(|e| PipelineError::Write {
            path: path.to_path_buf(),
            source: e,
        })
    };
    match write() {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use taletrek_synth::cache_key;

    /// Canonical mono 16-bit 16 kHz WAV with a little PCM — encoder-shape
    /// only, contents arbitrary (mirrors the desktop's engine tests).
    fn canonical_wav() -> Vec<u8> {
        let pcm = [0x01u8, 0x02, 0x03, 0x04];
        let data_len = pcm.len() as u32;
        let byte_rate = 16_000u32 * 2;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend_from_slice(&pcm);
        wav
    }

    /// Voice-source stub mirroring `voices::tests::StubSource`: serves the
    /// URL as body, `.onnx` padded to the catalog size band; records calls
    /// so cache-hit tests can assert no network.
    #[derive(Default)]
    struct StubSource {
        calls: Mutex<Vec<String>>,
    }

    impl VoiceSource for StubSource {
        fn fetch_with_progress(
            &self,
            url: &str,
            progress: &mut dyn FnMut(u64, u64),
        ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
            self.calls.lock().unwrap().push(url.to_string());
            let mut body = url.as_bytes().to_vec();
            if let Some(id) = url.rsplit('/').next().unwrap_or("").strip_suffix(".onnx") {
                if let Some(v) = crate::voices::find_curated(id) {
                    body.resize(v.size_bytes as usize, 0);
                }
            }
            progress(body.len() as u64, body.len() as u64);
            Ok(body)
        }
    }

    /// Stub runner: answers every predict with a canonical WAV.
    struct StubRunner;

    impl PiperRunner for StubRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav())
        }
    }

    /// Cancelling runner: trips the job's cancel flag on the first predict,
    /// so the NEXT paragraph boundary raises Cancelled through
    /// CancellableRunner — exercising the real per-paragraph path.
    struct CancelAfterFirstRunner {
        flag: CancelFlag,
        seen: usize,
    }

    impl PiperRunner for CancelAfterFirstRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            self.seen += 1;
            if self.seen == 1 {
                self.flag.store(true, Ordering::Relaxed);
            }
            Ok(canonical_wav())
        }
    }

    fn spec(books_dir: &Path, variant: PipelineVariant, runner: RunnerFactory) -> PipelineSpec {
        let espeak_root = books_dir.join("espeak");
        seed_espeak_marker(&espeak_root);
        PipelineSpec {
            source: b"chapter one\n\nalpha beta gamma\n\ndelta epsilon\n\nzeta eta theta".to_vec(),
            hint: Some("source.txt".to_string()),
            variant,
            generator_app: "taletrek-pipeline-test".to_string(),
            jobs: 1,
            resolve: ResolveOpts::new(None, books_dir.join("voices")),
            espeak_root,
            books_dir: books_dir.to_path_buf(),
            make_runner: runner,
            encoder: Arc::new(taletrek_synth::WavPassthrough),
        }
    }

    /// Pre-seed the `en_dict` marker so `ensure_espeak_data` short-circuits
    /// — the shared `spec()` default keeps routine tests offline and
    /// zip-URL-free; the ensure-path tests remove the marker to own
    /// freshness.
    fn seed_espeak_marker(espeak_root: &Path) {
        let data = espeak_root.join("espeak-ng-data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("en_dict"), b"marker").unwrap();
    }

    fn stub_factory() -> RunnerFactory {
        Arc::new(|| Box::new(StubRunner) as Box<dyn PiperRunner + Send>)
    }

    /// Run a full job with stubs into a fresh temp books dir.
    fn run_full(dir: &Path) -> PipelineOutcome {
        PipelineJob::new(spec(
            dir,
            PipelineVariant::Full { voice_id: None },
            stub_factory(),
        ))
        .run(&StubSource::default(), None)
        .expect("full pipeline run")
    }

    #[test]
    fn full_variant_produces_stamped_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = run_full(dir.path());
        assert!(!outcome.text_only);
        assert_eq!(outcome.chapters, 1);
        assert_eq!(outcome.paragraphs, 3);
        assert_eq!(outcome.segments, 3);

        let bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&outcome.bundle_path).unwrap())
                .unwrap();
        assert!(bundle.manifest.audio.present);
        assert_eq!(bundle.manifest.audio.segment_count, 3);
        assert_eq!(
            bundle.manifest.book.voice_id, DEFAULT_VOICE_ID,
            "voiceId = the resolved voice (None ⇒ curated default)"
        );
        assert_eq!(
            bundle.manifest.generator.app, "taletrek-pipeline-test",
            "generator.app = the host-passed string"
        );
        for paragraph in ["alpha beta gamma", "delta epsilon", "zeta eta theta"] {
            let key = cache_key(DEFAULT_VOICE_ID, paragraph);
            assert!(
                bundle.audio.contains_key(&key),
                "segment missing under cache_key for {paragraph:?}"
            );
        }
    }

    #[test]
    fn text_only_variant_writes_readable_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = PipelineJob::new(spec(
            dir.path(),
            PipelineVariant::TextOnly {
                voice_id: Some("en_US-ryan-medium".to_string()),
            },
            stub_factory(),
        ))
        .run(&StubSource::default(), None)
        .expect("text-only run");

        assert!(outcome.text_only);
        assert_eq!(outcome.segments, 0);
        let (manifest, _) = taletrek_synth::read_book_metadata(&outcome.bundle_path).unwrap();
        assert!(!manifest.audio.present);
        assert_eq!(manifest.book.voice_id, "en_US-ryan-medium");
    }

    #[test]
    fn book_id_is_deterministic_and_feeds_chapter_ids() {
        let dir = tempfile::tempdir().unwrap();
        let first = run_full(dir.path());
        let second = run_full(dir.path());
        assert_eq!(
            first.book_id, second.book_id,
            "same source bytes + hint ⇒ same book id (re-import idempotence)"
        );

        let bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&first.bundle_path).unwrap()).unwrap();
        assert_eq!(bundle.manifest.book.id, first.book_id);
        assert_eq!(
            bundle.chapters[0].id,
            format!("ch_{}_0", first.book_id),
            "chapter ids embed the book id (id fixed before chapter stamping)"
        );

        let other_dir = tempfile::tempdir().unwrap();
        let mut other = spec(
            other_dir.path(),
            PipelineVariant::Full { voice_id: None },
            stub_factory(),
        );
        other.source = b"chapter one\n\ncompletely different content here".to_vec();
        let outcome = PipelineJob::new(other)
            .run(&StubSource::default(), None)
            .unwrap();
        assert_ne!(
            outcome.book_id, first.book_id,
            "different content ⇒ different id"
        );
    }
    #[test]
    fn cancel_mid_synth_leaves_no_partial_book() {
        let dir = tempfile::tempdir().unwrap();
        // The stub runner trips the job's own flag after its first predict;
        // the factory reads the slot lazily (first runner construction
        // happens inside run, after the test has stored the handle).
        let slot: Arc<Mutex<Option<CancelFlag>>> = Arc::new(Mutex::new(None));
        let cancelling: RunnerFactory = {
            let slot = Arc::clone(&slot);
            Arc::new(move || {
                let flag = slot
                    .lock()
                    .unwrap()
                    .clone()
                    .expect("test stores the flag before run");
                Box::new(CancelAfterFirstRunner { flag, seen: 0 }) as Box<dyn PiperRunner + Send>
            })
        };
        let job = PipelineJob::new(spec(
            dir.path(),
            PipelineVariant::Full { voice_id: None },
            cancelling,
        ));
        slot.lock().unwrap().replace(job.cancel_flag());
        let err = job.run(&StubSource::default(), None).unwrap_err();
        assert!(
            matches!(err, PipelineError::Cancelled),
            "expected Cancelled, got {err:?}"
        );

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let books: Vec<_> = entries
            .iter()
            .filter(|e| !e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        // The voices cache dir content lives under voices/ — only bundle
        // artifacts at the top level count.
        let top_level: Vec<_> = books
            .iter()
            .filter(|n| n.ends_with(".taletrek") || n.ends_with(".tmp"))
            .collect();
        assert!(
            top_level.is_empty(),
            "cancel left artifacts behind: {top_level:?}"
        );
    }

    #[test]
    fn full_run_reports_phases_and_steps() {
        let dir = tempfile::tempdir().unwrap();
        #[derive(Default)]
        struct Recorder {
            events: Mutex<Vec<PipelineEvent>>,
        }
        impl PipelineReporter for Recorder {
            fn pipeline_event(&self, event: PipelineEvent) {
                self.events.lock().unwrap().push(event);
            }
        }
        let recorder = Recorder::default();
        let outcome = PipelineJob::new(spec(
            dir.path(),
            PipelineVariant::Full { voice_id: None },
            stub_factory(),
        ))
        .run(&StubSource::default(), Some(&recorder))
        .unwrap();
        let events = recorder.events.lock().unwrap().clone();
        assert!(events.contains(&PipelineEvent::Phase(PipelinePhase::Parsing)));
        assert!(events.contains(&PipelineEvent::Phase(PipelinePhase::ResolvingVoice)));
        assert!(events.contains(&PipelineEvent::Phase(PipelinePhase::Synthesizing)));
        assert!(events.contains(&PipelineEvent::Phase(PipelinePhase::Writing)));
        assert!(events.contains(&PipelineEvent::Parsed {
            chapters: 1,
            paragraphs: 3
        }));
        assert!(events
            .iter()
            .any(|e| matches!(e, PipelineEvent::SynthStep { done: 1, total: 3 })));
        assert_eq!(outcome.segments, 3);
    }

    /// Build a minimal in-memory espeak-ng-data zip: top-level
    /// `espeak-ng-data/` with the `en_dict` marker + padding entries so the
    /// body passes the download size band (zeros compress ~1000:1 — the
    /// band checks the wire size). Ported from `voices.rs` tests.
    fn espeak_zip_body() -> Vec<u8> {
        use std::io::Write as _;
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            zip.start_file("espeak-ng-data/en_dict", opts).unwrap();
            zip.write_all(b"marker").unwrap();
            let mut state = 0x2545_F491_4F6C_DD1Du64;
            for i in 0..96 {
                zip.start_file(format!("espeak-ng-data/lang/x/{i}"), opts)
                    .unwrap();
                let mut chunk = vec![0u8; 32 * 1024];
                for b in &mut chunk {
                    state = state
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    *b = (state >> 33) as u8;
                }
                zip.write_all(&chunk).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    /// Stub source serving both download lanes the full variant exercises:
    /// voice URLs get the padded stub body ([`StubSource`] behavior), the
    /// espeak zip URL gets a band-valid in-memory zip. Records calls.
    #[derive(Default)]
    struct ZipServingSource {
        calls: Mutex<Vec<String>>,
    }

    impl VoiceSource for ZipServingSource {
        fn fetch_with_progress(
            &self,
            url: &str,
            progress: &mut dyn FnMut(u64, u64),
        ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
            self.calls.lock().unwrap().push(url.to_string());
            let body = if url == crate::voices::ESPEAK_ZIP_URL {
                espeak_zip_body()
            } else {
                let mut body = url.as_bytes().to_vec();
                if let Some(id) = url.rsplit('/').next().unwrap_or("").strip_suffix(".onnx") {
                    if let Some(v) = crate::voices::find_curated(id) {
                        body.resize(v.size_bytes as usize, 0);
                    }
                }
                body
            };
            progress(body.len() as u64, body.len() as u64);
            Ok(body)
        }
    }

    #[test]
    fn full_variant_ensures_espeak_data_on_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let s = spec(
            dir.path(),
            PipelineVariant::Full { voice_id: None },
            stub_factory(),
        );
        // Own freshness: remove the marker the spec helper seeds so the job
        // must fetch the zip (and the voice — nothing is cached).
        fs::remove_file(s.espeak_root.join("espeak-ng-data/en_dict")).unwrap();

        #[derive(Default)]
        struct Recorder {
            events: Mutex<Vec<PipelineEvent>>,
        }
        impl PipelineReporter for Recorder {
            fn pipeline_event(&self, event: PipelineEvent) {
                self.events.lock().unwrap().push(event);
            }
        }
        let recorder = Recorder::default();
        let source = ZipServingSource::default();
        let outcome = PipelineJob::new(s)
            .run(&source, Some(&recorder))
            .expect("full first-run pipeline");

        assert!(!outcome.text_only, "the book is audible");
        assert!(
            source
                .calls
                .lock()
                .unwrap()
                .contains(&crate::voices::ESPEAK_ZIP_URL.to_string()),
            "espeak zip must be fetched when the marker is absent"
        );
        assert!(
            dir.path().join("espeak/espeak-ng-data/en_dict").is_file(),
            "the ensured marker must exist after the run"
        );
        let zip_len = espeak_zip_body().len() as u64;
        assert!(
            recorder.events.lock().unwrap().iter().any(
                |e| matches!(e, PipelineEvent::DownloadStep { bytes_total, .. } if *bytes_total == zip_len)
            ),
            "espeak download progress must ride DownloadStep events"
        );
    }

    #[test]
    fn espeak_fetch_failure_fails_typed_with_no_bundle_residue() {
        let dir = tempfile::tempdir().unwrap();
        let s = spec(
            dir.path(),
            PipelineVariant::Full { voice_id: None },
            stub_factory(),
        );
        fs::remove_file(s.espeak_root.join("espeak-ng-data/en_dict")).unwrap();

        #[derive(Default)]
        struct EspeakFailSource {
            calls: Mutex<Vec<String>>,
        }
        impl VoiceSource for EspeakFailSource {
            fn fetch_with_progress(
                &self,
                url: &str,
                _progress: &mut dyn FnMut(u64, u64),
            ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
                self.calls.lock().unwrap().push(url.to_string());
                if url == crate::voices::ESPEAK_ZIP_URL {
                    return Err("network down".into());
                }
                let mut body = url.as_bytes().to_vec();
                if let Some(id) = url.rsplit('/').next().unwrap_or("").strip_suffix(".onnx") {
                    if let Some(v) = crate::voices::find_curated(id) {
                        body.resize(v.size_bytes as usize, 0);
                    }
                }
                Ok(body)
            }
        }

        let err = PipelineJob::new(s)
            .run(&EspeakFailSource::default(), None)
            .unwrap_err();
        assert!(
            matches!(err, PipelineError::Espeak(_)),
            "expected Espeak, got {err:?}"
        );
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".taletrek") || n.ends_with(".tmp"))
            .collect();
        assert!(
            entries.is_empty(),
            "failed job left bundle artifacts behind: {entries:?}"
        );
    }

    #[test]
    fn text_only_variant_never_touches_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = ZipServingSource::default();
        let outcome = PipelineJob::new(spec(
            dir.path(),
            PipelineVariant::TextOnly { voice_id: None },
            stub_factory(),
        ))
        .run(&source, None)
        .expect("text-only run");
        assert!(outcome.text_only);
        assert!(
            source.calls.lock().unwrap().is_empty(),
            "text-only must fetch neither voice nor espeak"
        );
    }

    #[test]
    fn unknown_format_errors_typed() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = spec(
            dir.path(),
            PipelineVariant::TextOnly { voice_id: None },
            stub_factory(),
        );
        s.source = b"\x00\x01not any known format".to_vec();
        s.hint = Some("noextension".to_string());
        let err = PipelineJob::new(s)
            .run(&StubSource::default(), None)
            .unwrap_err();
        assert!(matches!(err, PipelineError::UnknownFormat { .. }));
    }

    #[cfg(feature = "sherpa")]
    #[test]
    #[ignore = "needs a real Piper voice + espeak-ng-data: TALETREK_VOICE_PATH + TALETREK_ESPEAK_DATA (or the seeded cache); see docs/testing.md"]
    fn real_sherpa_full_job_writes_a_real_bundle() {
        let voice_model = std::env::var_os("TALETREK_VOICE_PATH")
            .map(PathBuf::from)
            .or_else(|| {
                crate::voices::default_cache_dir()
                    .map(|d| d.join("voices/en_US-hfc_female-medium.onnx"))
            })
            .expect("TALETREK_VOICE_PATH or the seeded cache voice");
        let espeak = std::env::var_os("TALETREK_ESPEAK_DATA")
            .map(PathBuf::from)
            .or_else(|| dirs::cache_dir().map(|d| d.join("taletrek/espeak-ng-data")))
            .expect("TALETREK_ESPEAK_DATA or the seeded cache espeak-ng-data");

        let dir = tempfile::tempdir().unwrap();
        let make_runner: RunnerFactory = {
            let voice_model = voice_model.clone();
            let espeak = espeak.clone();
            Arc::new(move || {
                Box::new(
                    taletrek_synth::SherpaRunner::with_espeak_data(&voice_model, &espeak)
                        .expect("sherpa runner loads"),
                ) as Box<dyn PiperRunner + Send>
            })
        };
        let s = PipelineSpec {
            source: b"chapter one\n\nThe quick brown fox jumps over the lazy dog.".to_vec(),
            hint: Some("real.txt".to_string()),
            variant: PipelineVariant::Full { voice_id: None },
            generator_app: "taletrek-pipeline-e2e".to_string(),
            jobs: 1,
            resolve: ResolveOpts::new(Some(voice_model), dir.path().join("voices")),
            espeak_root: espeak
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
            books_dir: dir.path().to_path_buf(),
            make_runner,
            // WavPassthrough keeps this fixture dependent on sherpa alone —
            // opus encode is covered in crates/synth; the e2e gate enables
            // just taletrek-synth/sherpa.
            encoder: Arc::new(taletrek_synth::WavPassthrough),
        };
        let outcome = PipelineJob::new(s)
            .run(&crate::voices::UreqVoiceSource, None)
            .expect("full job");
        assert!(!outcome.text_only);
        assert_eq!(outcome.segments, 1);
        let bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&outcome.bundle_path).unwrap())
                .unwrap();
        assert!(bundle.manifest.audio.present);
        assert_eq!(bundle.manifest.audio.codec, AudioCodec::Wav);
    }
}
