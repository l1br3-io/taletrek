//! THROWAWAY spike shims (android-pipeline task 002) — deleted wholesale in
//! task 004 when the real `PipelineJob` + voice wrappers land. De-risks the
//! three phone-specific unknowns on real hardware:
//! (a) `resolve_voice` + `UreqVoiceSource` (ureq/rustls over JNI) against the
//!     real HuggingFace CDN, cache in the caller's `filesDir`;
//! (b) one-paragraph sherpa synth from the downloaded model;
//! (c) a UniFFI callback interface invoked from a rayon worker thread.
//!
//! GOTCHAs learned here must survive into task 004's real wrapper:
//! - never `default_cache_dir()` on Android (`dirs` resolves `$HOME`-style
//!   caches → `None` over JNI); the host always passes an absolute dir.
//! - espeak-ng-data: the desktop seeds it by copying out of the piper
//!   tarball, which doesn't exist on Android. k2-fsa ships the same runtime
//!   data as a standalone zip under the rolling `tts-models` release tag
//!   (9 MB, 355 entries, single top-level `espeak-ng-data/` dir — flat
//!   `<lang>_dict` files + `lang/**`, no `voices/`; this is the layout
//!   sherpa-onnx's own examples ship) — fetched + unzipped here. The rolling
//!   tag means content can drift; task 003's real acquire adds a size band
//!   like `verify_onnx_size` if it ever bites. `en_dict` is the cache
//!   marker.
//! - UniFFI 0.32 callback interfaces cross the boundary as `Box<dyn Trait>`
//!   (no `Arc` converter); declaring the trait `Send + Sync` lets the host
//!   side re-wrap it in a real `Arc` and ride it into the rayon pool. The
//!   generated vtable holder is `Send` by construction (handle = u64).

use std::fs;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use taletrek_synth::PiperRunner;
use taletrek_worker::voices::{resolve_voice, ResolveOpts, UreqVoiceSource, VoiceSource};
use taletrek_worker::ProgressSink;

/// The standalone espeak-ng-data zip (see module docs).
const ESPEAK_ZIP_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.zip";

/// Observer fed engine events (download progress, synth start/end) — the
/// callback-vs-poll probe. Kotlin records the receiving thread to settle the
/// spec's open question empirically.
#[uniffi::export(callback_interface)]
pub trait SpikeObserver: Send + Sync {
    /// One event line, `"<kind> <detail>"` shaped.
    fn on_event(&self, event: String);
}

/// Everything a spike call can fail with — deliberately stringly; the real
/// task-004 surface gets typed variants.
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum SpikeError {
    /// Download, unzip, or synth failure, stringified.
    #[error("spike: {detail}")]
    Failed {
        /// The stringified underlying failure.
        detail: String,
    },
}

/// Numbers the spike returns for the throughput datapoint.
#[derive(Debug, uniffi::Record)]
pub struct SpikeSynthOutcome {
    /// Synthesized canonical-WAV byte count.
    pub wav_bytes: u64,
    /// Audio seconds in that WAV (parsed, not estimated from bytes alone).
    pub audio_seconds: f64,
    /// Model load wall-time (the once-per-runner cost).
    pub load_ms: u64,
    /// One-paragraph predict wall-time.
    pub synth_ms: u64,
}

/// Adapter: forward `ProgressSink` calls to a [`SpikeObserver`] as events.
struct ObserverProgress(Arc<dyn SpikeObserver>);

impl ProgressSink for ObserverProgress {
    fn synth_step(&self, done: usize, total: usize) {
        self.0.on_event(format!("synth-step {done}/{total}"));
    }

    fn download_step(&self, bytes_done: u64, bytes_total: u64) {
        self.0
            .on_event(format!("download-step {bytes_done}/{bytes_total}"));
    }
}

fn err(detail: impl std::fmt::Display) -> SpikeError {
    SpikeError::Failed {
        detail: detail.to_string(),
    }
}

/// Resolve (and on first call download) the default curated voice from the
/// real HuggingFace CDN into `cache_dir` — returns the `.onnx` model path. A
/// warm cache short-circuits before any network (the observer sees no
/// `download-step` events — the test's cache-hit oracle).
#[uniffi::export]
pub fn spike_download_voice(
    cache_dir: String,
    observer: Box<dyn SpikeObserver>,
) -> Result<String, SpikeError> {
    let observer: Arc<dyn SpikeObserver> = Arc::from(observer);
    observer.on_event("download-start".to_string());
    let progress = ObserverProgress(Arc::clone(&observer));
    let resolved = resolve_voice(
        None,
        &ResolveOpts::new(None, PathBuf::from(cache_dir)),
        &UreqVoiceSource,
        Some(&progress),
    )
    .map(|p| p.display().to_string());
    observer.on_event("download-end".to_string());
    resolved.map_err(err)
}

/// Fetch + unzip espeak-ng-data (9 MB zip) into `data_root/espeak-ng-data`;
/// returns that dir. Idempotent: an existing `en_dict` marks the cache.
#[uniffi::export]
pub fn spike_fetch_espeak(
    data_root: String,
    observer: Box<dyn SpikeObserver>,
) -> Result<String, SpikeError> {
    let observer: Arc<dyn SpikeObserver> = Arc::from(observer);
    let root = Path::new(&data_root);
    let dest = root.join("espeak-ng-data");
    if dest.join("en_dict").is_file() {
        observer.on_event("espeak-cache-hit".to_string());
        return Ok(dest.display().to_string());
    }
    observer.on_event("espeak-download-start".to_string());
    let zip_bytes = UreqVoiceSource
        .fetch_with_progress(ESPEAK_ZIP_URL, &mut |done, total| {
            observer.on_event(format!("download-step {done}/{total}"));
        })
        .map_err(err)?;
    fs::create_dir_all(root).map_err(err)?;
    let tmp = root.join(format!("espeak-ng-data.zip.{}.tmp", std::process::id()));
    fs::write(&tmp, &zip_bytes).map_err(err)?;
    let extract = File::open(&tmp).map_err(|e| e.to_string()).and_then(|f| {
        zip::ZipArchive::new(f)
            .map_err(|e| e.to_string())
            .and_then(|mut a| a.extract(root).map_err(|e| e.to_string()))
    });
    let _ = fs::remove_file(&tmp);
    extract.map_err(err)?;
    if !dest.join("en_dict").is_file() {
        return Err(err("espeak zip extracted without espeak-ng-data/en_dict"));
    }
    observer.on_event("espeak-done".to_string());
    Ok(dest.display().to_string())
}

/// Load the sherpa model and synthesize one paragraph **on a rayon worker
/// thread** (the production pool shape), firing observer events from inside
/// that thread. Returns sizes + timings for the throughput datapoint.
#[uniffi::export]
pub fn spike_synth_paragraph(
    voice_model: String,
    espeak_dir: String,
    text: String,
    observer: Box<dyn SpikeObserver>,
) -> Result<SpikeSynthOutcome, SpikeError> {
    let observer: Arc<dyn SpikeObserver> = Arc::from(observer);
    let model = PathBuf::from(voice_model);
    let espeak = PathBuf::from(espeak_dir);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .map_err(err)?;
    pool.install(move || -> Result<SpikeSynthOutcome, SpikeError> {
        observer.on_event("synth-load-start".to_string());
        let t0 = Instant::now();
        let mut runner =
            taletrek_synth::SherpaRunner::with_espeak_data(&model, &espeak).map_err(err)?;
        let load_ms = t0.elapsed().as_millis() as u64;
        observer.on_event("synth-predict-start".to_string());
        let t1 = Instant::now();
        let wav = runner.predict(&model, &text).map_err(err)?;
        let synth_ms = t1.elapsed().as_millis() as u64;
        let audio_seconds = taletrek_synth::pcm::wav_duration(&wav);
        observer.on_event("synth-predict-end".to_string());
        Ok(SpikeSynthOutcome {
            wav_bytes: wav.len() as u64,
            audio_seconds,
            load_ms,
            synth_ms,
        })
    })
}
