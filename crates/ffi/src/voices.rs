//! Voice catalog + cache wrappers — the UI's voice-management surface.
//!
//! Mirrors the desktop voice view: list the curated catalog, download a
//! voice with progress, ask what's cached, delete one. Voice *selection*
//! is deliberately platform-side (DataStore on Android) — the kernel stays
//! stateless about which voice is "current". Also hosts the espeak-ng-data
//! ensure call (`ensure_espeak_data`) with the same observer shape.

use std::path::PathBuf;

use taletrek_worker::voices::{ensure_espeak_data, resolve_voice, EspeakError, ResolveError};
use taletrek_worker::{ProgressSink, UreqVoiceSource, VoiceQuality};

/// One curated voice entry.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FfiVoice {
    /// Curated id (`en_US-hfc_female-medium`) — the resolve key.
    pub id: String,
    /// Human display name.
    pub name: String,
    /// Locale tag (`en_US`).
    pub language: String,
    /// Quality tier (`low` | `medium` | `high`).
    pub quality: String,
    /// Approximate download size in bytes (progress-UI use).
    pub size_bytes: u64,
}

/// Progress observer for voice/espeak downloads. **Threading:** events
/// arrive on the calling thread (these calls are synchronous) — but see
/// [`crate::PipelineObserver`] for the async pipeline's contract.
#[uniffi::export(callback_interface)]
pub trait FfiVoiceObserver: Send + Sync {
    /// Download progress: `bytes_done` of `bytes_total` (`0` = unknown).
    fn on_download_step(&self, bytes_done: u64, bytes_total: u64);
}

/// All voice-surface failures, flattened for the foreign side.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum FfiVoiceError {
    /// Catalog resolution failed (unknown id, download, override).
    #[error("voice: {detail}")]
    Resolve {
        /// The kernel `ResolveError`'s Display.
        detail: String,
    },
    /// espeak-ng-data acquisition failed.
    #[error("espeak: {detail}")]
    Espeak {
        /// The kernel `EspeakError`'s Display.
        detail: String,
    },
}

/// Adapter: observer → ProgressSink.
pub(crate) struct FfiObserverProgress(pub Box<dyn FfiVoiceObserver>);

impl ProgressSink for FfiObserverProgress {
    fn synth_step(&self, _done: usize, _total: usize) {}

    fn download_step(&self, bytes_done: u64, bytes_total: u64) {
        self.0.on_download_step(bytes_done, bytes_total);
    }
}

/// The curated catalog (8 voices), in catalog order.
#[uniffi::export]
pub fn voice_catalog() -> Vec<FfiVoice> {
    taletrek_worker::CURATED_VOICES
        .iter()
        .map(|v| FfiVoice {
            id: v.id.to_string(),
            name: v.name.to_string(),
            language: v.language.to_string(),
            quality: match v.quality {
                VoiceQuality::Low => "low".to_string(),
                VoiceQuality::Medium => "medium".to_string(),
                VoiceQuality::High => "high".to_string(),
            },
            size_bytes: v.size_bytes,
        })
        .collect()
}

/// Resolve (and on first call download) a curated voice into
/// `cache_dir` — returns the `.onnx` model path. `None` = the curated
/// default. A warm cache short-circuits before any network.
#[uniffi::export]
pub fn ffi_resolve_voice(
    id: Option<String>,
    cache_dir: String,
    observer: Box<dyn FfiVoiceObserver>,
) -> Result<String, FfiVoiceError> {
    let progress = FfiObserverProgress(observer);
    resolve_voice(
        id.as_deref(),
        &taletrek_worker::ResolveOpts::new(None, PathBuf::from(cache_dir)),
        &UreqVoiceSource,
        Some(&progress),
    )
    .map(|p| p.display().to_string())
    .map_err(|e: ResolveError| FfiVoiceError::Resolve {
        detail: e.to_string(),
    })
}

/// Which curated voice ids have both cache files present in `cache_dir`.
#[uniffi::export]
pub fn cached_voice_ids(cache_dir: String) -> Vec<String> {
    let dir = PathBuf::from(cache_dir);
    taletrek_worker::CURATED_VOICES
        .iter()
        .filter(|v| {
            dir.join(format!("{}.onnx", v.id)).is_file()
                && dir.join(format!("{}.json", v.id)).is_file()
        })
        .map(|v| v.id.to_string())
        .collect()
}

/// Delete one cached voice (both files). Returns `true` when anything was
/// removed. Never touches voices that aren't in the catalog.
#[uniffi::export]
pub fn delete_cached_voice(cache_dir: String, id: String) -> bool {
    if taletrek_worker::find_curated(&id).is_none() {
        return false;
    }
    let dir = PathBuf::from(cache_dir);
    let onnx = dir.join(format!("{id}.onnx"));
    let json = dir.join(format!("{id}.json"));
    let removed_onnx = std::fs::remove_file(&onnx).is_ok();
    let removed_json = std::fs::remove_file(&json).is_ok();
    removed_onnx || removed_json
}

/// Ensure the espeak-ng-data phonemizer data exists at
/// `<data_root>/espeak-ng-data` and return that dir. Downloads (with
/// progress) on first call; idempotent afterwards. Required before the
/// first on-device synthesis.
#[uniffi::export]
pub fn ffi_ensure_espeak(
    data_root: String,
    observer: Box<dyn FfiVoiceObserver>,
) -> Result<String, FfiVoiceError> {
    let progress = FfiObserverProgress(observer);
    ensure_espeak_data(&PathBuf::from(data_root), &UreqVoiceSource, Some(&progress)).map_or_else(
        |e: EspeakError| {
            Err(FfiVoiceError::Espeak {
                detail: e.to_string(),
            })
        },
        |p| Ok(p.display().to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct RecordingObserver {
        steps: Mutex<Vec<(u64, u64)>>,
    }

    impl FfiVoiceObserver for RecordingObserver {
        fn on_download_step(&self, bytes_done: u64, bytes_total: u64) {
            self.steps.lock().unwrap().push((bytes_done, bytes_total));
        }
    }

    #[test]
    fn catalog_lists_every_curated_voice_with_sizes() {
        let catalog = voice_catalog();
        assert_eq!(catalog.len(), taletrek_worker::CURATED_VOICES.len());
        assert!(catalog.iter().all(|v| v.size_bytes > 1_000_000));
        assert!(catalog
            .iter()
            .any(|v| v.id == taletrek_worker::DEFAULT_VOICE_ID));
        assert!(catalog
            .iter()
            .all(|v| matches!(v.quality.as_str(), "low" | "medium" | "high")));
    }

    #[test]
    fn cache_list_and_delete_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("voices");
        fs::create_dir_all(&cache).unwrap();
        assert!(cached_voice_ids(cache.display().to_string()).is_empty());

        let id = taletrek_worker::DEFAULT_VOICE_ID;
        fs::write(cache.join(format!("{id}.onnx")), b"m").unwrap();
        fs::write(cache.join(format!("{id}.json")), b"{}").unwrap();
        assert_eq!(
            cached_voice_ids(cache.display().to_string()),
            vec![id.to_string()]
        );

        assert!(delete_cached_voice(
            cache.display().to_string(),
            id.to_string()
        ));
        assert!(cached_voice_ids(cache.display().to_string()).is_empty());
        assert!(!delete_cached_voice(
            cache.display().to_string(),
            "not-a-voice".to_string()
        ));
    }

    #[test]
    fn observer_receives_download_steps_via_the_progress_adapter() {
        let shared = Arc::new(RecordingObserver::default());
        let adapter = FfiObserverProgress(Box::new(ArcObserver(Arc::clone(&shared))));
        adapter.download_step(10, 100);
        adapter.download_step(100, 100);
        assert_eq!(*shared.steps.lock().unwrap(), vec![(10, 100), (100, 100)]);
    }

    /// `Arc<RecordingObserver>` forwarder (tests observe after the box
    /// crosses into the adapter).
    struct ArcObserver(Arc<RecordingObserver>);

    impl FfiVoiceObserver for ArcObserver {
        fn on_download_step(&self, bytes_done: u64, bytes_total: u64) {
            self.0.on_download_step(bytes_done, bytes_total);
        }
    }
}
