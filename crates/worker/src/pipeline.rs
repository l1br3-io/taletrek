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
//! open same-dir temp → **stream every synthesized segment into it** →
//! flush + rename). The full variant never materializes the bundle in
//! memory: the `BundleWriter` on the same-dir temp receives segments as the
//! sink engine completes them (manifest written last, atomic rename on
//! finish), so peak memory is one segment's working set regardless of book
//! length. Cancellation is cooperative and per-paragraph
//! ([`CancellableRunner`] checks the flag before every predict; stage
//! boundaries check it too) — a cancelled or failed job never leaves a
//! partial book behind, because the temp is removed and only a complete
//! archive is ever renamed into place.
//!
//! Threading: the job is `Send + 'static`-spawnable but thread-agnostic —
//! the FFI layer decides how to host it. Progress flows through
//! [`PipelineReporter`] (phase transitions + step counts), which the FFI
//! layer adapts into platform callbacks.

use std::fs;
use std::fs::File;
use std::io::{BufWriter, Cursor, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use thiserror::Error;

use taletrek_parse::{detect_format, parse_source, SourceFormat};
use taletrek_synth::bundle::manifest::Generator;
use taletrek_synth::cache_key;
use taletrek_synth::synth::{PiperRunner, SynthError};
use taletrek_synth::{write_book_bundle, AudioCodec, BookBundle, BundleWriter, Encoder};

use crate::stamp::{synth_and_stamp_streaming, StampError};
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
    /// Progressive (progressive-synth): the text-only bundle lands
    /// **immediately** (playable/importable), synth streams segments into
    /// the content-addressed [`crate::store::SegmentStore`] at
    /// `store_dir`, and on drain the book **seals** — segments merge back
    /// into a standard full bundle that atomically replaces the text one.
    /// Cancel/crash at any point leaves a valid text bundle + a reusable
    /// store; re-runs synthesize only missing keys (task 006).
    Progressive {
        /// Curated voice id to resolve and synthesize with.
        voice_id: Option<String>,
        /// Root dir of the segment store (hosts pass
        /// `<cache>/taletrek/segments`). Created on demand.
        store_dir: PathBuf,
    },
}

/// Seconds of audio (at the reading-order anchor — book start until task
/// 007 makes the anchor dynamic) that must exist before the pipeline
/// reports [`PipelineEvent::Playable`]. Originally 30 s from the
/// `bench-synth` baseline ([`bench.md`]); halved to 15 s post-ship
/// (2026-09-19) to cut warm-run time-to-first-listen — the horizon
/// scheduler keeps the pool aimed at the playhead window, so the buffer
/// rebuilds faster than it plays even when Playable fires earlier.
/// Revisit with real-phone RTF data (the owed bench datapoint).
pub const PLAYABLE_SECONDS: f64 = 15.0;

/// The read-ahead horizon: paragraphs whose estimated audio position is
/// within this window AHEAD of the anchor form the priority tier;
/// everything else (behind the anchor, or beyond) is fill, dispatched in
/// reading order after the tier. Calibrated from the bench baseline — at
/// Android's ~2–3× sustained RTF the pool produces 3 min of audio in
/// 1–1.5 min, so a 3-min window stays ahead of the playhead while leaving
/// the pool mostly for fill.
pub const HORIZON_SECONDS: f64 = 180.0;

/// Speech rate for the char→seconds estimator — measured on the reference
/// book (55,454 normalized chars → 2,996 s of audio ≈ 18.5 chars/s; see
/// `bench.md`), rounded down so estimates err toward over-filling the
/// horizon slightly.
pub const SPEECH_CHARS_PER_SECOND: f64 = 18.0;

/// The one char→audio-seconds heuristic (normalized chars at the measured
/// speech rate). Used by the anchor/horizon scheduler for paragraph
/// positions and — as a fallback — by the playable tracker when a stored
/// segment's duration can't be parsed. Exact measurements (the encoder
/// recorder, parsed WAV/OGG bytes) always win where they exist; this is
/// the single estimate, never a second divergent one.
#[must_use]
pub fn estimate_audio_seconds(normalized_chars: usize) -> f64 {
    normalized_chars as f64 / SPEECH_CHARS_PER_SECOND
}

/// Anchor dispatch rank: `(tier, distance, reading_index)` — tier 0 is the
/// horizon window ahead of the anchor (distance ascending = earliest
/// listen-first), tier 1 is everything else in reading order. Reading
/// order breaks distance ties deterministically.
fn anchor_rank(distance_seconds: f64, behind: bool, reading_index: usize) -> (u8, f64, usize) {
    let tier = u8::from(behind || distance_seconds > HORIZON_SECONDS);
    let distance = if tier == 0 { distance_seconds } else { 0.0 };
    (tier, distance, reading_index)
}

/// A playback position the scheduler aims audio production at: chapter and
/// paragraph indices into the book (the identity the kernel reader's
/// positions reduce to). Hosts set the initial anchor on the spec and move
/// it live via [`PipelineJob::set_anchor`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProgressiveAnchor {
    /// Chapter index into the bundle's chapter list.
    pub chapter: u32,
    /// Paragraph index within that chapter.
    pub paragraph: u32,
}

/// The live anchor state shared between the host handle and the scheduler
/// policy: the position plus an epoch counter the policy consults to
/// re-score the engine's pending queue.
#[derive(Debug, Default)]
struct AnchorShared {
    pos: std::sync::RwLock<ProgressiveAnchor>,
    epoch: Arc<AtomicU64>,
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
    /// Where the progressive scheduler aims production first: the resume
    /// position (a stored reader position) or book start when `None`.
    /// Movable live via [`PipelineJob::set_anchor`]; ignored by the
    /// text-only/full variants.
    pub initial_anchor: Option<ProgressiveAnchor>,
}

/// Runner factory: produces one engine runner per pool chunk.
pub type RunnerFactory = Arc<dyn Fn() -> Box<dyn PiperRunner + Send> + Send + Sync>;

/// Lifecycle phases, reported as they're entered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelinePhase {
    /// Detecting format + parsing source bytes.
    Parsing,
    /// Resolving/downloading the voice (full + progressive variants).
    ResolvingVoice,
    /// Synthesizing paragraphs (full + progressive variants).
    Synthesizing,
    /// Serializing + atomically writing the bundle.
    Writing,
    /// Merging store segments into the final full bundle (progressive
    /// only): the queue drained, the book is sealing.
    Sealing,
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
    /// `true` when the progressive variant sealed (text bundle replaced by
    /// the full one). Always `false` for text-only/full.
    pub sealed: bool,
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
    /// Progressive only: ≥ [`PLAYABLE_SECONDS`] of audio now exists at the
    /// anchor (book start) — the host may surface "start listening" now
    /// while synthesis continues.
    Playable,
    /// Progressive only: the queue drained and the sealed full bundle
    /// atomically replaced the text-only one. Terminal-adjacent (the job
    /// returns `Ok` immediately after).
    Sealed,
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
    /// The progressive segment store failed (I/O, invalid key, tampered
    /// file). Text-bundle-early means this never loses the book itself —
    /// only the reusable audio cache is affected.
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
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
    anchor: Arc<AnchorShared>,
}

impl PipelineJob {
    /// Build a job from a spec.
    pub fn new(spec: PipelineSpec) -> Self {
        let anchor = Arc::new(AnchorShared {
            pos: std::sync::RwLock::new(spec.initial_anchor.unwrap_or_default()),
            epoch: Arc::new(AtomicU64::new(0)),
        });
        Self {
            spec,
            flag: CancelFlag::default(),
            anchor,
        }
    }

    /// Request cancellation. In-flight synthesis unwinds at the next
    /// paragraph boundary; stage boundaries check before every transition.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }

    /// Move the scheduling anchor (progressive only): the pending queue
    /// re-scores at the next dispatch pop — paragraphs near the new
    /// position synthesize first; in-flight chunks finish (cancellation is
    /// the only preemption). A no-op before `run` (the anchor is also read
    /// at synth start).
    pub fn set_anchor(&self, anchor: ProgressiveAnchor) {
        if let Ok(mut pos) = self.anchor.pos.write() {
            *pos = anchor;
        }
        self.anchor.epoch.fetch_add(1, Ordering::Relaxed);
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
        let Self { spec, flag, anchor } = self;
        Self::run_parts(spec, flag, anchor, source, reporter)
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
        Self::run_parts(
            self.spec.clone(),
            Arc::clone(&self.flag),
            Arc::clone(&self.anchor),
            source,
            reporter,
        )
    }

    fn run_parts(
        spec: PipelineSpec,
        flag: CancelFlag,
        anchor: Arc<AnchorShared>,
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
            PipelineVariant::TextOnly { voice_id }
            | PipelineVariant::Full { voice_id }
            | PipelineVariant::Progressive { voice_id, .. } => voice_id
                .clone()
                .unwrap_or_else(|| DEFAULT_VOICE_ID.to_string()),
        };
        let text_only_bundle = to_text_only(&book, &voice, &spec.generator_app, &book_id);
        let bundle_path = spec.books_dir.join(format!("{book_id}.taletrek"));

        // Captured before the consuming variant match (the Progressive arm
        // needs the store dir + live anchor plus the spec by reference
        // afterwards).
        let progressive_cfg = match &spec.variant {
            PipelineVariant::Progressive { store_dir, .. } => Some(ProgressiveCfg {
                store_dir: store_dir.clone(),
                anchor: Arc::clone(&anchor),
            }),
            _ => None,
        };

        let (segments, was_text_only, sealed): (usize, bool, bool) = match spec.variant {
            // Text-only: tiny by construction — the in-memory write stays.
            PipelineVariant::TextOnly { .. } => {
                ensure_not_cancelled(&flag)?;
                emit(PipelineEvent::Phase(PipelinePhase::Writing));
                fs::create_dir_all(&spec.books_dir).map_err(|e| PipelineError::Write {
                    path: spec.books_dir.clone(),
                    source: e,
                })?;
                write_bundle_atomic(&text_only_bundle, &bundle_path)?;
                (0, true, false)
            }
            // Full: stream. The same-dir temp opens BEFORE the Synthesizing
            // phase; every synthesized segment flows through the sink stamp
            // straight into it (peak memory: one segment + text, never the
            // whole book's audio); the Writing phase is flush + atomic
            // rename. Nothing accumulates — `segments` is the stamped count.
            PipelineVariant::Full { .. } => {
                ensure_not_cancelled(&flag)?;
                emit(PipelineEvent::Phase(PipelinePhase::ResolvingVoice));
                let model = resolve_voice(Some(&voice), &spec.resolve, source, sink_ref)?;

                ensure_not_cancelled(&flag)?;
                ensure_espeak_data(&spec.espeak_root, source, sink_ref)?;

                // The temp must live in the destination dir (EXDEV) and the
                // dir must exist before the temp file can be created — dir
                // creation moves ahead of synth for this variant.
                fs::create_dir_all(&spec.books_dir).map_err(|e| PipelineError::Write {
                    path: spec.books_dir.clone(),
                    source: e,
                })?;
                let tmp = unique_tmp_path(&bundle_path);
                if let Some(dir) = bundle_path.parent() {
                    sweep_orphan_tmp(dir);
                }
                let discard_tmp = |e: PipelineError| {
                    let _ = fs::remove_file(&tmp);
                    e
                };
                let file = File::create(&tmp).map_err(|e| PipelineError::Write {
                    path: bundle_path.clone(),
                    source: e,
                })?;
                let mut bundle = text_only_bundle;
                let writer = BundleWriter::new(BufWriter::new(file), &bundle.chapters)
                    .map_err(|e| discard_tmp(StampError::from(e).into()))?;

                ensure_not_cancelled(&flag).map_err(discard_tmp)?;
                emit(PipelineEvent::Phase(PipelinePhase::Synthesizing));
                let cancelled_flag = Arc::clone(&flag);
                let factory = Arc::clone(&spec.make_runner);
                let make_runner =
                    move || CancellableRunner::new(Arc::clone(&cancelled_flag), factory());
                let encoder = SharedEncoder(Arc::clone(&spec.encoder));

                let stamped = synth_and_stamp_streaming_cancel_aware(
                    &mut bundle,
                    &voice,
                    &model,
                    make_runner,
                    &encoder,
                    spec.jobs,
                    &spec.generator_app,
                    sink_ref,
                    writer,
                );
                let (_sink, segment_count) = match stamped {
                    Ok(ok) => ok,
                    Err(e) => return Err(discard_tmp(e)),
                };

                ensure_not_cancelled(&flag).map_err(discard_tmp)?;
                emit(PipelineEvent::Phase(PipelinePhase::Writing));
                fs::rename(&tmp, &bundle_path).map_err(|e| {
                    discard_tmp(PipelineError::Write {
                        path: bundle_path.clone(),
                        source: e,
                    })
                })?;
                (segment_count as usize, false, false)
            }
            // Progressive: the text-only bundle lands NOW (importable +
            // the reader can open it), synth streams into the segment
            // store, and drain seals a full bundle over the text one.
            PipelineVariant::Progressive { .. } => {
                let ProgressiveCfg { store_dir, anchor } =
                    progressive_cfg.expect("progressive cfg captured before the variant match");
                let sealed = run_progressive(
                    &spec,
                    flag,
                    anchor,
                    source,
                    sink_ref,
                    reporter,
                    &voice,
                    text_only_bundle.clone(),
                    &bundle_path,
                    store_dir,
                )?;
                (sealed as usize, false, true)
            }
        };

        Ok(PipelineOutcome {
            book_id,
            bundle_path,
            text_only: was_text_only,
            chapters,
            paragraphs,
            segments,
            sealed,
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

/// The Progressive arm's pre-captured config (store dir + the live anchor),
/// taken before the consuming variant match.
struct ProgressiveCfg {
    store_dir: PathBuf,
    anchor: Arc<AnchorShared>,
}

/// The reading-order anchor tracker for [`PipelineEvent::Playable`]: how
/// much audio exists along the book-start prefix of the reading order.
struct PlayableTracker {
    order: Vec<String>,
    next: usize,
    delivered: std::collections::HashSet<String>,
    durations: std::collections::HashMap<String, f64>,
    prefix_total: f64,
    emitted: bool,
}

impl PlayableTracker {
    fn new(order: Vec<String>) -> Self {
        Self {
            order,
            next: 0,
            delivered: std::collections::HashSet::new(),
            durations: std::collections::HashMap::new(),
            prefix_total: 0.0,
            emitted: false,
        }
    }

    /// Record a delivery; advance the reading-order prefix over contiguous
    /// delivered keys. Returns `true` when the prefix grew (the caller
    /// re-checks the [`PLAYABLE_SECONDS`] threshold).
    fn deliver(&mut self, key: &str, seconds: f64) -> bool {
        self.delivered.insert(key.to_string());
        self.durations.insert(key.to_string(), seconds);
        let mut advanced = false;
        while self.next < self.order.len() && self.delivered.contains(&self.order[self.next]) {
            self.prefix_total += self.durations[&self.order[self.next]];
            self.next += 1;
            advanced = true;
        }
        advanced
    }
}

/// Recorded `(encoded bytes, wav seconds)` pairs from the encoder wrapper.
type RecordedDurations = Vec<(Vec<u8>, f64)>;

/// Encoder wrapper recording each encode's `(output bytes, input-WAV
/// seconds)` so the store sink can learn a delivered segment's audio
/// duration without parsing the encoded bytes — the map matches deliveries
/// by their encoded bytes (byte-identical outputs belong to deduped keys,
/// and equal-bytes duplicates pop FIFO).
struct DurationRecordingEncoder {
    inner: Arc<dyn Encoder + Send + Sync>,
    durations: Arc<Mutex<RecordedDurations>>,
}

impl Encoder for DurationRecordingEncoder {
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError> {
        let out = self.inner.encode(wav)?;
        self.durations
            .lock()
            .expect("duration recorder mutex")
            .push((out.clone(), taletrek_synth::pcm::wav_duration(wav)));
        Ok(out)
    }

    fn codec(&self) -> AudioCodec {
        self.inner.codec()
    }
}

/// Pop the first duration recorded for `bytes` (0.0 when unmatched — the
/// playable heuristic degrades gracefully, never blocks delivery).
fn pop_duration(durations: &mut RecordedDurations, bytes: &[u8]) -> f64 {
    durations
        .iter()
        .position(|(b, _)| b == bytes)
        .map(|i| durations.remove(i).1)
        .unwrap_or(0.0)
}

/// A stored segment's playback seconds, by codec: WAV via header parse,
/// Opus via the manual OGG page-granule scan (no feature-gated deps);
/// anything else counts as 0.0 (the playable heuristic degrades, never
/// blocks).
fn stored_duration_seconds(seg: &taletrek_synth::AudioSegment) -> f64 {
    match seg.codec {
        AudioCodec::Wav => taletrek_synth::pcm::wav_duration(&seg.bytes),
        AudioCodec::Opus => taletrek_synth::pcm::opus_duration_seconds(&seg.bytes),
        AudioCodec::M4a => 0.0,
    }
}

/// The text bundle reduced to paragraphs whose keys are NOT in `existing`
/// (the resume skip set) — the engine's work list. Chapter identity and
/// order are preserved so planning keys stay identical; chapters may end
/// up empty (the engine iterates them harmlessly).
fn reduce_to_missing(
    bundle: &BookBundle,
    voice: &str,
    existing: &std::collections::HashSet<String>,
) -> BookBundle {
    let mut reduced = bundle.clone();
    for chapter in &mut reduced.chapters {
        chapter
            .paragraphs
            .retain(|p| !existing.contains(&cache_key(voice, p)));
    }
    reduced
}

/// Progress lift for resumed runs: the engine reports over MISSING keys
/// only; this wrapper re-bases `done` onto the seeded count and reports the
/// FULL distinct total, so hosts never see a lying 0% flash.
struct ResumeProgressSink<'a> {
    seeded: usize,
    total: usize,
    inner: Option<&'a dyn ProgressSink>,
}

impl ProgressSink for ResumeProgressSink<'_> {
    fn synth_step(&self, done: usize, _engine_total: usize) {
        if let Some(inner) = self.inner {
            inner.synth_step(self.seeded + done, self.total);
        }
    }

    fn download_step(&self, bytes_done: u64, bytes_total: u64) {
        if let Some(inner) = self.inner {
            inner.download_step(bytes_done, bytes_total);
        }
    }
}

/// The book's audio timeline: per-paragraph estimated positions (cumulative
/// [`estimate_audio_seconds`] over the reading order), the
/// (chapter, paragraph) → reading-index map, and the ordering policy built
/// on top — the whole anchor/horizon scheduling policy lives here, in the
/// pipeline; the engine only applies the resulting order.
struct AudioTimeline {
    /// Reading-order distinct keys (first-occurrence dedup).
    keys: Vec<String>,
    /// Estimated start time (seconds from book start) per reading-order
    /// paragraph.
    starts: Vec<f64>,
    /// (chapter, paragraph) → first-occurrence reading index.
    at: std::collections::HashMap<(u32, u32), usize>,
}

impl AudioTimeline {
    fn build(voice: &str, chapters: &[taletrek_synth::ChapterText]) -> Self {
        let mut keys = Vec::new();
        let mut starts = Vec::new();
        let mut at = std::collections::HashMap::new();
        let mut seen = std::collections::HashSet::new();
        let mut cumulative = 0.0;
        for (chapter_idx, chapter) in chapters.iter().enumerate() {
            for (para_idx, para) in chapter.paragraphs.iter().enumerate() {
                let key = cache_key(voice, para);
                if seen.insert(key.clone()) {
                    keys.push(key);
                    starts.push(cumulative);
                    at.insert((chapter_idx as u32, para_idx as u32), starts.len() - 1);
                }
                cumulative += estimate_audio_seconds(
                    taletrek_synth::normalize_for_speech(para).chars().count(),
                );
            }
        }
        Self { keys, starts, at }
    }

    /// Reading index of an anchor position (book start for unmapped
    /// positions).
    fn index_of(&self, pos: ProgressiveAnchor) -> usize {
        self.at
            .get(&(pos.chapter, pos.paragraph))
            .copied()
            .unwrap_or(0)
    }

    /// The engine ordering policy over PLANNED (missing) paragraphs: the
    /// engine's plan order is the reading order of the reduced bundle, so
    /// `reduced` maps each engine index to its full-timeline index. Reads
    /// the LIVE anchor each invocation; ties break in reading order.
    fn order_policy(
        &self,
        anchor: Arc<AnchorShared>,
        existing: &std::collections::HashSet<String>,
    ) -> crate::synth_job::ParagraphOrderPolicy {
        // The reduced reading order (missing keys only), as full-timeline
        // indices — index-aligned with the engine's planned paragraphs.
        let reduced: Vec<usize> = self
            .keys
            .iter()
            .enumerate()
            .filter(|(_, k)| !existing.contains(*k))
            .map(|(i, _)| i)
            .collect();
        let starts = self.starts.clone();
        let at = self.at.clone();
        Arc::new(move |views: &[crate::synth_job::ParagraphPlanView]| {
            let pos = anchor.pos.read().map(|pos| *pos).unwrap_or_default();
            let anchor_time = starts
                .get(at.get(&(pos.chapter, pos.paragraph)).copied().unwrap_or(0))
                .copied()
                .unwrap_or(0.0);
            let mut ranked: Vec<((u8, f64, usize), usize)> = views
                .iter()
                .enumerate()
                .map(|(engine_idx, view)| {
                    let full_idx = reduced.get(view.reading_index).copied().unwrap_or(0);
                    let t = starts.get(full_idx).copied().unwrap_or(0.0);
                    let (behind, distance) = if t < anchor_time {
                        (true, anchor_time - t)
                    } else {
                        (false, t - anchor_time)
                    };
                    (
                        anchor_rank(distance, behind, view.reading_index),
                        engine_idx,
                    )
                })
                .collect();
            ranked.sort_unstable_by(|a, b| {
                a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)
            });
            ranked.into_iter().map(|(_, idx)| idx).collect()
        })
    }
}

/// The Progressive variant: text bundle early → store-driven synth → seal.
/// Returns the sealed segment count (the full bundle is already in place at
/// `bundle_path`).
///
/// Lifecycle: resolve voice + ensure espeak (unchanged seams) → **write the
/// text-only bundle atomically, immediately** (importable + resumable
/// before any synth) → synth with the segment store as the sink
/// ([`PipelineEvent::Playable`] fires once the reading-order prefix holds
/// [`PLAYABLE_SECONDS`] of audio) → on drain, **seal**: stream store
/// segments through a [`BundleWriter`] over a same-dir temp and atomically
/// replace the text bundle ([`PipelineEvent::Sealed`]). Cancel or failure
/// at any stage leaves a valid text bundle + a reusable store — never a
/// corrupt book, never a partial full bundle (the temp is discarded).
#[allow(clippy::too_many_arguments)] // one cohesive variant stage; the spec seam set
fn run_progressive(
    spec: &PipelineSpec,
    flag: CancelFlag,
    anchor: Arc<AnchorShared>,
    source: &dyn VoiceSource,
    sink_ref: Option<&dyn ProgressSink>,
    reporter: Option<&dyn PipelineReporter>,
    voice: &str,
    text_bundle: BookBundle,
    bundle_path: &Path,
    store_dir: PathBuf,
) -> Result<u32, PipelineError> {
    let emit = |event: PipelineEvent| {
        if let Some(r) = reporter {
            r.pipeline_event(event);
        }
    };

    ensure_not_cancelled(&flag)?;
    emit(PipelineEvent::Phase(PipelinePhase::ResolvingVoice));
    let model = resolve_voice(Some(voice), &spec.resolve, source, sink_ref)?;

    ensure_not_cancelled(&flag)?;
    ensure_espeak_data(&spec.espeak_root, source, sink_ref)?;

    // The book lands NOW: a text-only bundle is small, valid, and the
    // resume anchor for every later stage (including crashes).
    fs::create_dir_all(&spec.books_dir).map_err(|e| PipelineError::Write {
        path: spec.books_dir.clone(),
        source: e,
    })?;
    write_bundle_atomic(&text_bundle, bundle_path)?;

    // Synth drains into the store; the playable tracker watches the
    // reading-order prefix FROM THE INITIAL ANCHOR (a stored resume position
    // counts from there; mid-run anchor moves re-score scheduling only —
    // Playable is one-shot).
    let store = crate::store::SegmentStore::open(&store_dir)?;
    let timeline = AudioTimeline::build(voice, &text_bundle.chapters);
    let reading_order = timeline.keys.clone();
    let durations: Arc<Mutex<RecordedDurations>> = Arc::new(Mutex::new(Vec::new()));
    let initial_anchor_pos = anchor.pos.read().map(|pos| *pos).unwrap_or_default();
    let anchor_full_idx = timeline.index_of(initial_anchor_pos);
    let playable_order: Vec<String> =
        reading_order[anchor_full_idx.min(reading_order.len())..].to_vec();
    let tracker = Arc::new(Mutex::new(PlayableTracker::new(playable_order)));

    // Resume (task 006): keys already in the store are never re-synthesized
    // — they count as delivered for the playable tracker, fast-forward the
    // progress stream (no lying 0% flash), and are skipped by the engine
    // via a reduced work bundle.
    let existing: std::collections::HashSet<String> = store
        .keys()
        .map_err(PipelineError::Store)?
        .into_iter()
        .collect();
    let seeded: Vec<&String> = reading_order
        .iter()
        .filter(|k| existing.contains(*k))
        .collect();
    if !reading_order.is_empty() {
        if let Some(sink) = sink_ref {
            sink.synth_step(seeded.len(), reading_order.len());
        }
    }
    {
        let mut t = tracker.lock().expect("playable tracker mutex");
        let mut advanced = false;
        for key in &seeded {
            // Duration by codec from the stored bytes (WAV parse or OGG
            // granule scan); a mid-scan eviction miss degrades to 0.0 s.
            let seconds = store
                .get(key)
                .map_err(PipelineError::Store)?
                .map(|seg| stored_duration_seconds(&seg))
                .unwrap_or(0.0);
            advanced |= t.deliver(key, seconds);
        }
        if advanced && !t.emitted && t.prefix_total >= PLAYABLE_SECONDS {
            t.emitted = true;
            drop(t);
            if let Some(r) = reporter {
                r.pipeline_event(PipelineEvent::Playable);
            }
        }
    }
    let reduced_bundle = reduce_to_missing(&text_bundle, voice, &existing);

    let encoder = DurationRecordingEncoder {
        inner: Arc::clone(&spec.encoder),
        durations: Arc::clone(&durations),
    };

    let sink_store = store.clone();
    let sink = crate::synth_job::SegmentSink::new(move |key, seg| {
        sink_store
            .put(&seg)
            .map_err(|e| taletrek_synth::BundleError::Io(std::io::Error::other(e.to_string())))?;
        let seconds = {
            let mut recorded = durations.lock().expect("duration recorder mutex");
            pop_duration(&mut recorded, &seg.bytes)
        };
        let mut t = tracker.lock().expect("playable tracker mutex");
        let advanced = t.deliver(&key, seconds);
        if advanced && !t.emitted && t.prefix_total >= PLAYABLE_SECONDS {
            t.emitted = true;
            drop(t);
            if let Some(r) = reporter {
                r.pipeline_event(PipelineEvent::Playable);
            }
        }
        Ok(())
    });

    ensure_not_cancelled(&flag)?;
    emit(PipelineEvent::Phase(PipelinePhase::Synthesizing));
    let cancelled_flag = Arc::clone(&flag);
    let factory = Arc::clone(&spec.make_runner);
    let make_runner = move || CancellableRunner::new(Arc::clone(&cancelled_flag), factory());
    // Engine steps report over the MISSING keys only; the resume wrapper
    // lifts them onto the full total so hosts see done grow from the seeded
    // count to all.
    let resume_progress = ResumeProgressSink {
        seeded: seeded.len(),
        total: reading_order.len(),
        inner: sink_ref,
    };
    // Anchor/horizon scheduling policy: rank planned (missing) paragraphs
    // by their position on the book's audio timeline relative to the LIVE
    // anchor. The engine applies it up front and re-applies it after every
    // anchor epoch change.
    let policy = timeline.order_policy(Arc::clone(&anchor), &existing);
    let synth = crate::synth_paragraphs_into_dynamic(
        &reduced_bundle,
        voice,
        &model,
        make_runner,
        &encoder,
        spec.jobs,
        Some(&resume_progress),
        Some(policy),
        Some(Arc::clone(&anchor.epoch)),
        &sink,
    );
    drop(sink);
    match synth {
        Ok(()) => {}
        Err(SynthJobError::Synth(SynthError::Cancelled)) => {
            return Err(PipelineError::Cancelled);
        }
        Err(e) => return Err(PipelineError::Stamp(StampError::Synth(e))),
    }

    // Drain reached: seal the store's segments over the text bundle.
    ensure_not_cancelled(&flag)?;
    emit(PipelineEvent::Phase(PipelinePhase::Sealing));
    let count = seal_progressive(
        &text_bundle,
        bundle_path,
        &store,
        &reading_order,
        spec.encoder.codec(),
        &spec.generator_app,
    )?;
    emit(PipelineEvent::Sealed);
    Ok(count)
}

/// Seal: stream every reading-order segment from the store through a
/// [`BundleWriter`] onto a same-dir temp, stamp the manifest through the
/// same single stamping path the batch flavors use, and atomically replace
/// the text-only bundle. Output is byte-compatible with a batch `Full` run
/// over the same input (same writer, same stamp, same keys).
#[allow(clippy::too_many_arguments)] // mirrors the seal's inputs; cohesive
fn seal_progressive(
    text_bundle: &BookBundle,
    bundle_path: &Path,
    store: &crate::store::SegmentStore,
    reading_order: &[String],
    codec: AudioCodec,
    generator_app: &str,
) -> Result<u32, PipelineError> {
    let tmp = unique_tmp_path(bundle_path);
    let discard_tmp = |e: PipelineError| {
        let _ = fs::remove_file(&tmp);
        e
    };

    let file = File::create(&tmp).map_err(|e| {
        discard_tmp(PipelineError::Write {
            path: bundle_path.to_path_buf(),
            source: e,
        })
    })?;
    let writer = BundleWriter::new(BufWriter::new(file), &text_bundle.chapters)
        .map_err(|e| discard_tmp(StampError::from(e).into()))?;
    let writer = Arc::new(Mutex::new(writer));

    for key in reading_order {
        let seg = store
            .get(key)
            .map_err(|e| discard_tmp(PipelineError::Store(e)))?
            .ok_or_else(|| {
                discard_tmp(PipelineError::Stamp(StampError::from(
                    taletrek_synth::BundleError::InvalidAudioKey(format!(
                        "segment {key} missing from the store at seal time"
                    )),
                )))
            })?;
        writer
            .lock()
            .expect("seal writer mutex")
            .add_segment(key, &seg)
            .map_err(|e| discard_tmp(StampError::from(e).into()))?;
    }

    let writer = match Arc::try_unwrap(writer) {
        Ok(mutex) => mutex.into_inner().expect("seal writer mutex unpoisoned"),
        Err(_) => unreachable!("seal writer arc unique after the loop"),
    };
    let segment_count = writer.segment_count();
    let mut manifest = text_bundle.manifest.clone();
    crate::stamp::stamp_manifest_fields(&mut manifest, codec, segment_count, generator_app);
    writer
        .finish(manifest)
        .map_err(|e| discard_tmp(StampError::from(e).into()))?;

    fs::rename(&tmp, bundle_path).map_err(|e| {
        discard_tmp(PipelineError::Write {
            path: bundle_path.to_path_buf(),
            source: e,
        })
    })?;
    Ok(segment_count)
}

/// [`synth_and_stamp_streaming`] with cancel-aware error mapping: a cancelled
/// synth surfaces as [`PipelineError::Cancelled`], everything else keeps its
/// typed [`StampError`] identity.
#[allow(clippy::too_many_arguments)] // mirrors synth_and_stamp_streaming's signature; see stamp.rs
fn synth_and_stamp_streaming_cancel_aware<R, E, F, W>(
    bundle: &mut BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    generator_app: &str,
    progress: Option<&dyn ProgressSink>,
    writer: BundleWriter<W>,
) -> Result<(W, u32), PipelineError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
    W: Write + Seek + Send + 'static,
{
    match synth_and_stamp_streaming(
        bundle,
        voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        generator_app,
        progress,
        writer,
    ) {
        Ok(ok) => Ok(ok),
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

/// Unique same-dir temp path for `path`: `<name>.<pid>.<seq>.tmp`. Shared by
/// the in-memory atomic write and the streaming full variant — the temp MUST
/// live in the destination directory (rename across filesystems — e.g.
/// /cache → /data — fails with `EXDEV`), and the pid+seq suffix keeps
/// concurrent jobs writing the same book id from clobbering each other's
/// temp.
fn unique_tmp_path(path: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
    ))
}

/// Whether `pid` names a live process. On Linux/Android (procfs mounted —
/// every TaleTrek target) this is a stat away; anywhere else it conservatively
/// reports alive so [`sweep_orphan_tmp`] never deletes what it can't judge.
#[cfg(target_os = "linux")]
fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// Non-Linux hosts (macOS — the ios-app effort's second dev machine)
/// have no `/proc`: `ps -p` is the portable probe (exit 0 = the pid
/// exists, 1 = not). A subprocess is fine here — the sweeper runs once
/// per import over a handful of temps, and the crate forbids unsafe,
/// which rules out a hand-declared kill(2).
#[cfg(not(target_os = "linux"))]
fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Delete streaming-temp leftovers in `dir` — files in the
/// [`unique_tmp_path`] shape (`<name>.<pid>.<seq>.tmp`) whose pid is dead. A
/// SIGKILL'd job (OOM/LMK on-device) cannot run its own cleanup, and the
/// temps are whole-bundle-sized, so they'd silently eat storage. Best-effort:
/// unparseable names, non-tmp files, and live-pid temps are left alone, and
/// failures to stat or unlink are ignored.
fn sweep_orphan_tmp(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".tmp") else {
            continue;
        };
        // <base>.<pid>.<seq>: parse the two trailing dot-fields as numbers.
        let mut fields = stem.rsplit('.');
        let (Some(seq), Some(pid_field), Some(_base)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if seq.is_empty() || pid_field.is_empty() {
            continue;
        }
        let (Ok(_seq), Ok(pid)) = (seq.parse::<u32>(), pid_field.parse::<u32>()) else {
            continue;
        };
        if !pid_alive(pid) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// GOTCHA: atomic bundle write — the temp file MUST live in the destination
/// directory (rename across filesystems — e.g. /cache → /data — fails with
/// `EXDEV`), and its name must be unique per attempt so concurrent jobs
/// writing the same book id can't clobber each other's temp. Last complete
/// rename wins, and a failed job's temp is removed, never promoted.
fn write_bundle_atomic(bundle: &BookBundle, path: &Path) -> Result<(), PipelineError> {
    let mut buffer = Cursor::new(Vec::new());
    write_book_bundle(bundle, &mut buffer).map_err(StampError::from)?;
    let tmp = unique_tmp_path(path);
    if let Some(dir) = path.parent() {
        sweep_orphan_tmp(dir);
    }
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

    /// A pid that is not currently alive: scanned down from the top of the
    /// default-allocated range so it can never collide with a real process.
    fn dead_pid() -> u32 {
        (3_000_000..4_000_000)
            .find(|p| !pid_alive(*p))
            .expect("a pid in 3M..4M is always unallocated")
    }

    #[test]
    fn sweep_removes_only_dead_pid_temps() {
        let dir = tempfile::tempdir().unwrap();
        let mk = |name: &str| dir.path().join(name);

        let orphan = mk(&format!("bk_x.taletrek.{}.0.tmp", dead_pid()));
        let mine = mk(&format!("bk_x.taletrek.{}.0.tmp", std::process::id()));
        let unrelated = mk("notes.tmp");
        let malformed = mk("bk_x.taletrek.notapid.0.tmp");
        let bundle = mk("bk_y.taletrek");
        for path in [&orphan, &mine, &unrelated, &malformed, &bundle] {
            fs::write(path, b"bytes").unwrap();
        }

        sweep_orphan_tmp(dir.path());

        assert!(!orphan.exists(), "dead-pid temp must be swept");
        assert!(mine.exists(), "live-pid temp must survive");
        assert!(unrelated.exists(), "non-pid .tmp must survive");
        assert!(malformed.exists(), "unparseable name must survive");
        assert!(bundle.exists(), "completed bundles are never touched");
    }

    #[test]
    fn sweep_tolerates_missing_dir() {
        sweep_orphan_tmp(Path::new("/nonexistent-taletrek-sweep"));
    }

    #[test]
    fn pid_alive_reports_for_self_and_the_dead() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(dead_pid()));
    }

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
            initial_anchor: None,
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
    fn full_variant_failure_after_temp_creation_removes_streaming_temp() {
        // The full variant must open its temp file BEFORE the Synthesizing
        // phase (streaming into it as segments complete) and remove it when
        // the job fails after that point. The runner observes whether a .tmp
        // sibling exists at synth time (discriminating: the in-memory path
        // would see none) and fails its first predict to abort the run.
        struct TempObservingFailingRunner {
            books_dir: PathBuf,
            saw_tmp: Arc<std::sync::atomic::AtomicBool>,
            checked: bool,
        }
        impl PiperRunner for TempObservingFailingRunner {
            fn predict(&mut self, _m: &Path, _t: &str) -> Result<Vec<u8>, SynthError> {
                if !self.checked {
                    self.checked = true;
                    let saw = fs::read_dir(&self.books_dir)
                        .map(|entries| {
                            entries
                                .filter_map(Result::ok)
                                .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
                        })
                        .unwrap_or(false);
                    self.saw_tmp.store(saw, Ordering::Relaxed);
                }
                Err(SynthError::EncoderIo(std::io::Error::other(
                    "stub synth failure",
                )))
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let saw_tmp = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let books_dir = dir.path().to_path_buf();
        let observed = Arc::clone(&saw_tmp);
        let factory: RunnerFactory = Arc::new(move || {
            Box::new(TempObservingFailingRunner {
                books_dir: books_dir.clone(),
                saw_tmp: Arc::clone(&observed),
                checked: false,
            }) as Box<dyn PiperRunner + Send>
        });
        let err = PipelineJob::new(spec(
            dir.path(),
            PipelineVariant::Full { voice_id: None },
            factory,
        ))
        .run(&StubSource::default(), None)
        .unwrap_err();
        assert!(
            matches!(err, PipelineError::Stamp(_)),
            "expected Stamp, got {err:?}"
        );
        assert!(
            saw_tmp.load(Ordering::Relaxed),
            "the streaming temp must exist during the Synthesizing phase"
        );

        let residue: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".taletrek") || n.ends_with(".tmp"))
            .collect();
        assert!(
            residue.is_empty(),
            "failed job left artifacts behind: {residue:?}"
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

    // ---- Progressive variant (progressive-synth task 005) ----

    /// Spec for a progressive run: same source as the shared `spec()`, with
    /// the segment store rooted at `<books>/segments`.
    fn progressive_spec(books_dir: &Path, runner: RunnerFactory) -> PipelineSpec {
        let mut s = spec(
            books_dir,
            PipelineVariant::Progressive {
                voice_id: None,
                store_dir: books_dir.join("segments"),
            },
            runner,
        );
        s.encoder = Arc::new(taletrek_synth::WavPassthrough);
        s
    }

    /// A stub WAV carrying `secs` of silence (16 kHz mono 16-bit) — long
    /// enough to trip PLAYABLE_SECONDS without real synthesis.
    fn long_wav(secs: f64) -> Vec<u8> {
        let pcm_len = (16_000.0 * 2.0 * secs) as u32;
        let mut wav = canonical_wav_header(pcm_len);
        wav.resize(44 + pcm_len as usize, 0x00);
        wav
    }

    fn canonical_wav_header(data_len: u32) -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&32_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav
    }

    #[test]
    fn progressive_writes_text_bundle_before_any_synth_then_seals() {
        let dir = tempfile::tempdir().unwrap();
        // The runner factory records whether the text bundle already exists
        // at the moment the FIRST runner is constructed (i.e. before any
        // predict could run).
        let text_bundle_seen_at_first_runner: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
        let seen = Arc::clone(&text_bundle_seen_at_first_runner);
        let books = dir.path().to_path_buf();
        let factory: RunnerFactory = Arc::new(move || {
            let mut slot = seen.lock().unwrap();
            if slot.is_none() {
                // Any bundle-ish file at the top level proves the early
                // write: the runner is constructed only during synth.
                let exists = std::fs::read_dir(&books)
                    .map(|entries| {
                        entries.filter_map(|e| e.ok()).any(|e| {
                            let name = e.file_name();
                            let name = name.to_string_lossy();
                            name.ends_with(".taletrek") || name.contains(".tmp")
                        })
                    })
                    .unwrap_or(false);
                *slot = Some(exists);
            }
            Box::new(StubRunner) as Box<dyn PiperRunner + Send>
        });

        let outcome = PipelineJob::new(progressive_spec(dir.path(), factory))
            .run(&StubSource::default(), None)
            .expect("progressive run");

        assert_eq!(
            *text_bundle_seen_at_first_runner.lock().unwrap(),
            Some(true),
            "the text-only bundle must exist on disk before any runner is constructed"
        );
        assert!(outcome.sealed);
        assert!(!outcome.text_only);
        assert_eq!(outcome.segments, 3, "distinct paragraphs");
        assert!(!outcome.book_id.is_empty());

        let bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&outcome.bundle_path).unwrap())
                .unwrap();
        assert!(bundle.manifest.audio.present, "sealed bundle is full");
        assert_eq!(bundle.manifest.audio.segment_count, 3);
        for paragraph in ["alpha beta gamma", "delta epsilon", "zeta eta theta"] {
            let key = cache_key(DEFAULT_VOICE_ID, paragraph);
            assert!(bundle.audio.contains_key(&key));
        }

        // The store still holds the segments (re-convert stays near-free).
        let store = crate::store::SegmentStore::open(&dir.path().join("segments")).unwrap();
        assert_eq!(store.keys().unwrap().len(), 3);
    }

    #[test]
    fn progressive_sealed_bundle_matches_a_batch_full_run() {
        let full_dir = tempfile::tempdir().unwrap();
        let prog_dir = tempfile::tempdir().unwrap();

        let full = run_full(full_dir.path());
        let prog = PipelineJob::new(progressive_spec(prog_dir.path(), stub_factory()))
            .run(&StubSource::default(), None)
            .expect("progressive run");
        assert_eq!(full.book_id, prog.book_id, "same source ⇒ same id");

        let full_bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&full.bundle_path).unwrap()).unwrap();
        let prog_bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&prog.bundle_path).unwrap()).unwrap();

        // Manifest parity, timestamp fields excepted (parse stamps wall
        // clock at bundle build).
        let f = &full_bundle.manifest;
        let p = &prog_bundle.manifest;
        assert_eq!(f.schema_version, p.schema_version);
        assert_eq!(f.kind, p.kind);
        assert_eq!(f.book.id, p.book.id);
        assert_eq!(f.book.title, p.book.title);
        assert_eq!(f.book.author, p.book.author);
        assert_eq!(f.book.source_format, p.book.source_format);
        assert_eq!(f.book.chapter_count, p.book.chapter_count);
        assert_eq!(f.book.voice_id, p.book.voice_id);
        assert_eq!(f.book.progress_fraction, p.book.progress_fraction);
        assert_eq!(f.audio.present, p.audio.present);
        assert_eq!(f.audio.codec, p.audio.codec);
        assert_eq!(f.audio.norm_version, p.audio.norm_version);
        assert_eq!(f.audio.segment_count, p.audio.segment_count);
        assert_eq!(f.generator.app, p.generator.app);
        assert_eq!(f.generator.version, p.generator.version);
        assert_eq!(
            full_bundle.chapters.len(),
            prog_bundle.chapters.len(),
            "same chapter shape"
        );
        for (fc, pc) in full_bundle.chapters.iter().zip(&prog_bundle.chapters) {
            assert_eq!(fc.id, pc.id);
            assert_eq!(fc.title, pc.title);
            assert_eq!(fc.paragraphs, pc.paragraphs);
        }

        // Audio byte-parity: same keys, same bytes.
        assert_eq!(full_bundle.audio.len(), prog_bundle.audio.len());
        for (key, seg) in &full_bundle.audio {
            assert_eq!(
                prog_bundle.audio.get(key).expect("same keys").bytes,
                seg.bytes,
                "segment bytes must be byte-identical to the batch run"
            );
        }
    }

    #[test]
    fn progressive_cancel_mid_synth_keeps_text_bundle_and_store() {
        let dir = tempfile::tempdir().unwrap();
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
        let job = PipelineJob::new(progressive_spec(dir.path(), cancelling));
        slot.lock().unwrap().replace(job.cancel_flag());
        let err = job.run(&StubSource::default(), None).unwrap_err();
        assert!(
            matches!(err, PipelineError::Cancelled),
            "expected Cancelled, got {err:?}"
        );

        // The text-only bundle survives, valid + openable.
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let bundles: Vec<_> = entries
            .iter()
            .filter(|n| n.ends_with(".taletrek"))
            .collect();
        assert_eq!(
            bundles.len(),
            1,
            "exactly the early text bundle: {entries:?}"
        );
        let path = dir.path().join(bundles[0].as_str());
        let (manifest, _) = taletrek_synth::read_book_metadata(&path).unwrap();
        assert!(!manifest.audio.present, "still text-only after cancel");

        // No orphan temps from the (never-reached) seal.
        assert!(
            entries.iter().all(|n| !n.ends_with(".tmp")),
            "no temp leftovers: {entries:?}"
        );

        // The store holds the segments completed before the cancel.
        let store = crate::store::SegmentStore::open(&dir.path().join("segments")).unwrap();
        assert!(
            !store.keys().unwrap().is_empty(),
            "completed segments persist for resume"
        );
    }

    #[test]
    fn progressive_emits_playable_then_sealed_in_order() {
        // Each stub segment carries 31 s of audio, so the first delivery
        // pushes the reading-order prefix over PLAYABLE_SECONDS.
        struct LongRunner;
        impl PiperRunner for LongRunner {
            fn predict(&mut self, _m: &Path, _t: &str) -> Result<Vec<u8>, SynthError> {
                Ok(long_wav(31.0))
            }
        }
        let long_factory: RunnerFactory =
            Arc::new(|| Box::new(LongRunner) as Box<dyn PiperRunner + Send>);

        #[derive(Default, Clone)]
        struct Recorder {
            events: Arc<Mutex<Vec<PipelineEvent>>>,
        }
        impl PipelineReporter for Recorder {
            fn pipeline_event(&self, event: PipelineEvent) {
                self.events.lock().unwrap().push(event);
            }
        }
        let recorder = Recorder::default();

        let dir = tempfile::tempdir().unwrap();
        let outcome = PipelineJob::new(progressive_spec(dir.path(), long_factory))
            .run(&StubSource::default(), Some(&recorder))
            .expect("progressive run");
        assert!(outcome.sealed);

        let events = recorder.events.lock().unwrap();
        let position = |target: PipelineEvent| {
            events
                .iter()
                .position(|e| *e == target)
                .unwrap_or_else(|| panic!("{target:?} missing from {events:?}"))
        };
        let playable = position(PipelineEvent::Playable);
        let sealed = position(PipelineEvent::Sealed);
        let first_step = events
            .iter()
            .position(|e| matches!(e, PipelineEvent::SynthStep { .. }))
            .expect("a synth step");
        assert!(
            playable > first_step,
            "Playable fires after audio exists, not before synth: {events:?}"
        );
        assert!(playable < sealed, "Playable precedes Sealed: {events:?}");
        assert_eq!(
            events
                .iter()
                .filter(|e| **e == PipelineEvent::Playable)
                .count(),
            1,
            "Playable is emitted exactly once: {events:?}"
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| **e == PipelineEvent::Sealed)
                .count(),
            1,
            "Sealed is emitted exactly once: {events:?}"
        );
    }

    // ---- resume / skip-existing (progressive-synth task 006) ----

    /// A counting runner factory: records every construction so tests can
    /// prove which runs synthesized anything at all.
    fn counting_factory() -> (RunnerFactory, Arc<Mutex<usize>>) {
        let calls = Arc::new(Mutex::new(0));
        let seen = Arc::clone(&calls);
        let factory: RunnerFactory = Arc::new(move || {
            *seen.lock().unwrap() += 1;
            Box::new(StubRunner) as Box<dyn PiperRunner + Send>
        });
        (factory, calls)
    }

    /// Cancel-after-first runner behind the shared slot pattern.
    fn cancelling_factory(slot: &Arc<Mutex<Option<CancelFlag>>>) -> RunnerFactory {
        let slot = Arc::clone(slot);
        Arc::new(move || {
            let flag = slot
                .lock()
                .unwrap()
                .clone()
                .expect("test stores the flag before run");
            Box::new(CancelAfterFirstRunner { flag, seen: 0 }) as Box<dyn PiperRunner + Send>
        })
    }

    #[test]
    fn progressive_resume_synthesizes_only_missing_keys() {
        // Run 1 cancels after the first predict (one segment lands in the
        // store). Run 2 must synthesize only the two missing keys and seal.
        let dir = tempfile::tempdir().unwrap();
        let store_dir = dir.path().join("segments");

        let slot: Arc<Mutex<Option<CancelFlag>>> = Arc::new(Mutex::new(None));
        let job = PipelineJob::new(progressive_spec(dir.path(), cancelling_factory(&slot)));
        slot.lock().unwrap().replace(job.cancel_flag());
        let err = job.run(&StubSource::default(), None).unwrap_err();
        assert!(matches!(err, PipelineError::Cancelled));
        let seeded = crate::store::SegmentStore::open(&store_dir)
            .unwrap()
            .keys()
            .unwrap();
        assert_eq!(seeded.len(), 1, "cancel left exactly one segment");

        let (factory, _calls) = counting_factory();
        let outcome = PipelineJob::new(progressive_spec(dir.path(), factory))
            .run(&StubSource::default(), None)
            .expect("resume run seals");
        assert!(outcome.sealed);
        assert_eq!(outcome.segments, 3);

        // The store + sealed bundle prove all three keys exist; only the
        // two missing ones were synthesized this run (runner constructed
        // exactly once for the remaining work).
        let store = crate::store::SegmentStore::open(&store_dir).unwrap();
        assert_eq!(store.keys().unwrap().len(), 3);
        let bundle =
            taletrek_synth::read_book_bundle(&std::fs::read(&outcome.bundle_path).unwrap())
                .unwrap();
        assert_eq!(bundle.manifest.audio.segment_count, 3);
    }

    #[test]
    fn progressive_fully_seeded_store_seals_with_zero_runner_constructions() {
        let dir = tempfile::tempdir().unwrap();
        // Run 1 fills the store completely.
        PipelineJob::new(progressive_spec(dir.path(), stub_factory()))
            .run(&StubSource::default(), None)
            .expect("seeding run");

        // Run 2 over the same source: every key hits the store — the
        // engine never constructs a runner.
        let (factory, calls) = counting_factory();
        let outcome = PipelineJob::new(progressive_spec(dir.path(), factory))
            .run(&StubSource::default(), None)
            .expect("full-hit run seals");
        assert!(outcome.sealed);
        assert_eq!(outcome.segments, 3);
        assert_eq!(
            *calls.lock().unwrap(),
            0,
            "zero runner constructions — nothing to synthesize"
        );
    }

    #[test]
    fn progressive_resume_progress_starts_at_the_seeded_count() {
        // Cancel after the first paragraph, then resume with a recorder:
        // the FIRST SynthStep must read (1, 3) — no lying 0% flash.
        let dir = tempfile::tempdir().unwrap();

        let slot: Arc<Mutex<Option<CancelFlag>>> = Arc::new(Mutex::new(None));
        let job = PipelineJob::new(progressive_spec(dir.path(), cancelling_factory(&slot)));
        slot.lock().unwrap().replace(job.cancel_flag());
        assert!(matches!(
            job.run(&StubSource::default(), None).unwrap_err(),
            PipelineError::Cancelled
        ));

        #[derive(Default, Clone)]
        struct Recorder {
            events: Arc<Mutex<Vec<PipelineEvent>>>,
        }
        impl PipelineReporter for Recorder {
            fn pipeline_event(&self, event: PipelineEvent) {
                self.events.lock().unwrap().push(event);
            }
        }
        let recorder = Recorder::default();

        let outcome = PipelineJob::new(progressive_spec(dir.path(), stub_factory()))
            .run(&StubSource::default(), Some(&recorder))
            .expect("resume run");
        assert!(outcome.sealed);

        let events = recorder.events.lock().unwrap();
        let first_step = events
            .iter()
            .find(|e| matches!(e, PipelineEvent::SynthStep { .. }))
            .expect("at least one step");
        assert_eq!(
            *first_step,
            PipelineEvent::SynthStep { done: 1, total: 3 },
            "first step reflects the seeded segment: {events:?}"
        );
        assert!(
            events.contains(&PipelineEvent::SynthStep { done: 3, total: 3 }),
            "run completes to 3/3: {events:?}"
        );
    }

    #[test]
    fn progressive_skip_uses_exact_cache_key_bytes_across_normalization() {
        // G30 lineage: a curly-quoted paragraph and its ASCII twin share a
        // cache key (the key normalizes internally). A store seeded by the
        // curly book serves the ASCII book with zero synthesis.
        let dir = tempfile::tempdir().unwrap();
        let curly = "chapter one\n\nIt\u{2019}s a curly \u{2014} test paragraph.\n\nplain second";
        let ascii = "chapter one\n\nIt's a curly - test paragraph.\n\nplain second";

        let seed_spec = |source: &[u8]| {
            let mut s = progressive_spec(dir.path(), stub_factory());
            s.source = source.to_vec();
            s
        };
        PipelineJob::new(seed_spec(curly.as_bytes()))
            .run(&StubSource::default(), None)
            .expect("curly seeding run");

        let (_factory, calls) = counting_factory();
        let outcome = PipelineJob::new(seed_spec(ascii.as_bytes()))
            .run(&StubSource::default(), None)
            .expect("ascii run");
        assert!(outcome.sealed);
        assert_eq!(
            *calls.lock().unwrap(),
            0,
            "the curly-seeded store serves the ASCII twin — same cache keys"
        );
        assert_eq!(outcome.segments, 2);
    }

    // ---- anchor + horizon (progressive-synth task 007) ----

    /// A 12-paragraph book (one chapter) with distinguishable texts.
    fn anchored_source() -> Vec<u8> {
        let paras: Vec<String> = (0..12)
            .map(|i| format!("Paragraph number {i} of the anchored fixture book."))
            .collect();
        format!("Chapter One\n\n{}", paras.join("\n\n")).into_bytes()
    }

    /// A runner recording every predicted text (jobs=1 keeps consumption
    /// order exact).
    struct RecordingTextRunner {
        predicts: Arc<Mutex<Vec<String>>>,
    }

    impl PiperRunner for RecordingTextRunner {
        fn predict(&mut self, _m: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
            self.predicts.lock().unwrap().push(text.to_string());
            Ok(canonical_wav())
        }
    }

    fn text_recording_factory(predicts: &Arc<Mutex<Vec<String>>>) -> RunnerFactory {
        let seen = Arc::clone(predicts);
        Arc::new(move || {
            Box::new(RecordingTextRunner {
                predicts: seen.clone(),
            }) as Box<dyn PiperRunner + Send>
        })
    }

    /// Progressive spec with explicit source + anchor.
    fn progressive_spec_with(
        books_dir: &Path,
        runner: RunnerFactory,
        source: Vec<u8>,
        anchor: Option<ProgressiveAnchor>,
    ) -> PipelineSpec {
        let mut s = progressive_spec(books_dir, runner);
        s.source = source;
        s.initial_anchor = anchor;
        s
    }

    #[test]
    fn estimator_converts_chars_at_the_measured_rate() {
        assert_eq!(estimate_audio_seconds(0), 0.0);
        assert!((estimate_audio_seconds(18) - 1.0).abs() < 1e-9);
        assert!((estimate_audio_seconds(180) - 10.0).abs() < 1e-9);
        assert!(estimate_audio_seconds(36) > estimate_audio_seconds(18));
    }

    #[test]
    fn anchor_rank_tiers_horizon_first_and_breaks_ties_by_reading_order() {
        // Ahead within the horizon: tier 0, distance ascending.
        let near = anchor_rank(10.0, false, 5);
        let far = anchor_rank(170.0, false, 7);
        assert!(near < far, "closer-ahead ranks first");
        // Beyond the horizon: tier 1 (reading order among them).
        let beyond = anchor_rank(HORIZON_SECONDS + 1.0, false, 2);
        assert_eq!(beyond.0, 1);
        assert!(far < beyond, "horizon tier precedes fill");
        // Behind the anchor: fill, regardless of distance.
        let behind = anchor_rank(1.0, true, 3);
        assert_eq!(behind.0, 1, "behind the anchor is fill");
        // Equal distance ties break by reading index.
        let a = anchor_rank(42.0, false, 4);
        let b = anchor_rank(42.0, false, 9);
        assert!(a < b);
    }

    #[test]
    fn initial_anchor_synthesizes_the_anchored_position_first() {
        // Anchor at paragraph 8 of 12: the first synthesized chunk must be
        // paragraph 8's (jobs=1 makes consumption order exact).
        let dir = tempfile::tempdir().unwrap();
        let predicts: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        let spec = progressive_spec_with(
            dir.path(),
            text_recording_factory(&predicts),
            anchored_source(),
            Some(ProgressiveAnchor {
                chapter: 0,
                paragraph: 8,
            }),
        );
        let outcome = PipelineJob::new(spec)
            .run(&StubSource::default(), None)
            .expect("anchored run");
        assert!(outcome.sealed);

        let texts = predicts.lock().unwrap();
        let first = texts.first().expect("predicts happened").clone();
        assert!(
            first.contains("number 8"),
            "the anchored paragraph synthesizes first, got {first:?} (of {texts:?})"
        );
    }

    #[test]
    fn set_anchor_mid_run_re_prioritizes_to_the_new_neighborhood() {
        // After the 2nd predict the anchor jumps to paragraph 10. With
        // jobs=1 the NEXT predicts must be paragraph 10's chunks, not the
        // original reading order's paragraph 2/3.
        let dir = tempfile::tempdir().unwrap();
        let predicts: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        let slot: Arc<Mutex<Option<Arc<PipelineJob>>>> = Arc::new(Mutex::new(None));
        let job_holder = Arc::clone(&slot);
        let seen = Arc::clone(&predicts);
        let factory: RunnerFactory = Arc::new(move || {
            // The recorder wrapper trips the seek after the 2nd predict —
            // the test stores the job handle before run_shared starts.
            struct SeekAfter {
                predicts: Arc<Mutex<Vec<String>>>,
                job: Arc<Mutex<Option<Arc<PipelineJob>>>>,
                inner: RecordingTextRunner,
            }
            impl PiperRunner for SeekAfter {
                fn predict(&mut self, m: &Path, text: &str) -> Result<Vec<u8>, SynthError> {
                    let out = self.inner.predict(m, text)?;
                    let count = self.predicts.lock().unwrap().len();
                    if count == 2 {
                        if let Some(job) = self.job.lock().unwrap().as_ref() {
                            job.set_anchor(ProgressiveAnchor {
                                chapter: 0,
                                paragraph: 10,
                            });
                        }
                    }
                    Ok(out)
                }
            }
            Box::new(SeekAfter {
                predicts: seen.clone(),
                job: job_holder.clone(),
                inner: RecordingTextRunner {
                    predicts: seen.clone(),
                },
            }) as Box<dyn PiperRunner + Send>
        });

        let spec = progressive_spec_with(
            dir.path(),
            factory,
            anchored_source(),
            Some(ProgressiveAnchor {
                chapter: 0,
                paragraph: 0,
            }),
        );
        let job = Arc::new(PipelineJob::new(spec));
        slot.lock().unwrap().replace(Arc::clone(&job));
        let outcome = job
            .run_shared(&StubSource::default(), None)
            .expect("seek run");
        assert!(outcome.sealed);

        let texts = predicts.lock().unwrap();
        // Horizon at paragraph 10 covers 10 and 11 (the book ends at 11);
        // then fill resumes in reading order.
        let after_seek: Vec<&String> = texts.iter().skip(2).take(2).collect();
        assert!(
            after_seek
                .iter()
                .all(|t| t.contains("number 10") || t.contains("number 11")),
            "post-seek predicts must be the new neighborhood, got {after_seek:?} (all: {texts:?})"
        );
    }
}
