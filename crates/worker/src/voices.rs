//! Voice catalog + resolve/download/cache — the shared worker stack used by
//! both `taletrek-desktop` and `taletrek-server`.
//!
//! Mirrors the SPA's curated English voice catalog (`web/src/lib/tts/voices.ts`)
//! and the HuggingFace base + path map (`web/src/lib/tts/vendor/piper/models.ts`)
//! so the three apps fetch voice models from identical URLs.
//!
//! Resolution has two paths:
//! 1. **`--voice-path` override** (`ResolveOpts::voice_path`): point directly at
//!    a `.onnx` file on disk. Skips download entirely (offline / pre-downloaded).
//!    `voices.rs` pre-checks the adjacent `<stem>.json` config exists so piper
//!    doesn't fail opaquely.
//! 2. **Curated id**: look the id up in [`CURATED_VOICES`], then either reuse
//!    the cached files under `cache_dir` or download both `.onnx` + `.json`
//!    from `HF_BASE`. Network access is behind the [`VoiceSource`] trait so
//!    unit tests stub HTTP.

use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::ProgressSink;

/// The HuggingFace base the SPA downloads Piper voices from. Verbatim copy of
/// `web/src/lib/tts/vendor/piper/models.ts`'s `HF_BASE` so URLs match exactly.
pub const HF_BASE: &str = "https://huggingface.co/diffusionstudio/piper-voices/resolve/main";

/// The curated voice used when `--voice` is omitted. Matches the SPA's
/// `DEFAULT_VOICE_ID` (`web/src/lib/tts/voices.ts`).
pub const DEFAULT_VOICE_ID: &str = "en_US-hfc_female-medium";

/// Voice quality tier (mirrors `web/src/lib/tts/types.ts` `VoiceQuality`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceQuality {
    /// Low bitrate / smallest model.
    Low,
    /// Default tier — the curated catalog is entirely `Medium`.
    Medium,
    /// Best quality / largest model.
    High,
}

/// A curated voice entry. Mirrors the `Voice` interface in
/// `web/src/lib/tts/types.ts` — id, display name, quality, approximate model
/// size, and BCP-47 locale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Voice {
    /// Package voice key, e.g. `en_US-hfc_female-medium`.
    pub id: &'static str,
    /// Short human-readable display name, e.g. `HFC Female`.
    pub name: &'static str,
    /// Quality tier.
    pub quality: VoiceQuality,
    /// Approximate model `.onnx` size in bytes (for progress UI).
    pub size_bytes: u64,
    /// BCP-47-style locale code, e.g. `en_US`.
    pub language: &'static str,
}

/// The 8 curated English medium voices. Verbatim mirror of the SPA's
/// `CURATED_VOICES` (`web/src/lib/tts/voices.ts`): 5 US + 3 GB, all medium.
/// Selection rationale and sizes are documented there.
pub const CURATED_VOICES: &[Voice] = &[
    Voice {
        id: "en_US-hfc_female-medium",
        name: "HFC Female",
        quality: VoiceQuality::Medium,
        size_bytes: 63_201_294,
        language: "en_US",
    },
    Voice {
        id: "en_US-ryan-medium",
        name: "Ryan",
        quality: VoiceQuality::Medium,
        size_bytes: 63_201_294,
        language: "en_US",
    },
    Voice {
        id: "en_US-amy-medium",
        name: "Amy",
        quality: VoiceQuality::Medium,
        size_bytes: 63_201_294,
        language: "en_US",
    },
    Voice {
        id: "en_US-lessac-medium",
        name: "Lessac",
        quality: VoiceQuality::Medium,
        size_bytes: 63_201_294,
        language: "en_US",
    },
    Voice {
        id: "en_US-kristin-medium",
        name: "Kristin",
        quality: VoiceQuality::Medium,
        size_bytes: 63_531_379,
        language: "en_US",
    },
    Voice {
        id: "en_GB-alan-medium",
        name: "Alan",
        quality: VoiceQuality::Medium,
        size_bytes: 63_201_294,
        language: "en_GB",
    },
    Voice {
        id: "en_GB-alba-medium",
        name: "Alba",
        quality: VoiceQuality::Medium,
        size_bytes: 63_201_294,
        language: "en_GB",
    },
    Voice {
        id: "en_GB-cori-medium",
        name: "Cori",
        quality: VoiceQuality::Medium,
        size_bytes: 63_531_379,
        language: "en_GB",
    },
];

/// Look up a curated voice by id, or `None` if not in the catalog.
pub fn find_curated(id: &str) -> Option<&'static Voice> {
    CURATED_VOICES.iter().find(|v| v.id == id)
}

/// Curated id → relative path under [`HF_BASE`] (including the `.onnx`
/// extension), mirroring the matching entry in the SPA's `PATH_MAP`
/// (`web/src/lib/tts/vendor/piper/models.ts`). Returns `None` for ids not in
/// [`CURATED_VOICES`]; only curated ids resolve to a download URL.
fn curated_rel_onnx_path(id: &str) -> Option<&'static str> {
    let map: &[(&str, &str)] = &[
        (
            "en_US-hfc_female-medium",
            "en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx",
        ),
        (
            "en_US-ryan-medium",
            "en/en_US/ryan/medium/en_US-ryan-medium.onnx",
        ),
        (
            "en_US-amy-medium",
            "en/en_US/amy/medium/en_US-amy-medium.onnx",
        ),
        (
            "en_US-lessac-medium",
            "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
        ),
        (
            "en_US-kristin-medium",
            "en/en_US/kristin/medium/en_US-kristin-medium.onnx",
        ),
        (
            "en_GB-alan-medium",
            "en/en_GB/alan/medium/en_GB-alan-medium.onnx",
        ),
        (
            "en_GB-alba-medium",
            "en/en_GB/alba/medium/en_GB-alba-medium.onnx",
        ),
        (
            "en_GB-cori-medium",
            "en/en_GB/cori/medium/en_GB-cori-medium.onnx",
        ),
    ];
    map.iter().find(|(k, _)| *k == id).map(|(_, v)| *v)
}

/// Resolve `<cache_dir>/<id>.onnx` (cache layout matches the SPA's flat
/// basename-keyed OPFS layout — see `voiceFilenames` in `models.ts`).
fn cache_onnx_path(cache_dir: &Path, id: &str) -> PathBuf {
    cache_dir.join(format!("{id}.onnx"))
}

/// Build the full HF download URL for a curated voice's `.onnx` or `.json`.
fn hf_url(rel_path: &str) -> String {
    format!("{HF_BASE}/{rel_path}")
}

/// Inputs to [`resolve_voice`] that aren't the voice id itself.
#[derive(Debug, Clone)]
pub struct ResolveOpts {
    /// `--voice-path <model.onnx>` override. When `Some`, the curated catalog
    /// and download path are skipped entirely.
    pub voice_path: Option<PathBuf>,
    /// Directory to cache downloaded voice models under. Files land at
    /// `<cache_dir>/<voice_id>.onnx` and `<cache_dir>/<voice_id>.json`.
    pub cache_dir: PathBuf,
}

impl ResolveOpts {
    /// Build opts from a CLI flag + the platform cache dir. `cache_dir` falls
    /// back to `./.cache/taletrek/voices/` when the platform has no discoverable
    /// cache dir (e.g. no `$HOME`); the real path comes from [`default_cache_dir`].
    pub fn new(voice_path: Option<PathBuf>, cache_dir: PathBuf) -> Self {
        Self {
            voice_path,
            cache_dir,
        }
    }
}

/// The platform voice cache dir: `$XDG_CACHE_HOME/taletrek/voices/` on Linux
/// (`~/.cache/taletrek/voices/`), platform equivalent elsewhere. `None` when
/// the platform exposes no discoverable cache home (no `$HOME`).
pub fn default_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("taletrek").join("voices"))
}

/// Testable seam over voice-model HTTP fetch. The streaming variant
/// ([`VoiceSource::fetch_with_progress`]) invokes `progress(bytes_done,
/// bytes_total)` as bytes arrive so a [`ProgressSink::download_step`] reporter
/// can render `voice d.t MiB (pct%)` lines; `bytes_total` is `0` when the
/// source can't report a length. Unit tests stub the network by implementing
/// the streaming method directly and asserting cache-hit short-circuits +
/// progress callbacks without going online. The non-streaming
/// [`VoiceSource::fetch`] is provided for callers that don't care about
/// per-byte progress.
pub trait VoiceSource {
    /// Fetch the full byte body at `url`, invoking `progress(bytes_done,
    /// bytes_total)` as bytes arrive. `bytes_total` is `0` when the source
    /// doesn't report a length. Errors carry enough context for
    /// [`ResolveError::Download`] to surface the failing URL.
    fn fetch_with_progress(
        &self,
        url: &str,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>>;

    /// Fetch without per-byte progress. The default delegates to
    /// [`VoiceSource::fetch_with_progress`] with a no-op callback.
    fn fetch(&self, url: &str) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
        self.fetch_with_progress(url, &mut |_, _| {})
    }
}

/// Production [`VoiceSource`] backed by `ureq` (blocking HTTP). Chosen over
/// `reqwest` for minimal footprint (ADR-0013). Streams the response body in
/// 64 KiB chunks and reports throttled progress (one line per integer pct, or
/// per whole MiB when `Content-Length` is absent) so a 63 MiB download emits
/// ~100 lines, not ~1000.
#[derive(Debug, Default, Clone, Copy)]
pub struct UreqVoiceSource;

impl VoiceSource for UreqVoiceSource {
    fn fetch_with_progress(
        &self,
        url: &str,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
        let resp = ureq::get(url).call()?;
        let total: u64 = resp
            .headers()
            .get("Content-Length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let mut reader = resp.into_body().into_reader();
        let mut buf = Vec::with_capacity(1024 * 1024);
        let mut chunk = [0u8; 64 * 1024];
        let mut done: u64 = 0;
        let mut last_pct: i64 = -1;
        let mut last_mib: u64 = 0;
        loop {
            let n = reader.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            done += n as u64;
            // Throttle: only call back when the integer pct (known length) or
            // whole-MiB count (unknown length) changes. `checked_div` returning
            // `None` covers `total == 0` (no Content-Length) → per-MiB path.
            match done
                .checked_mul(100)
                .and_then(|x| x.checked_div(total))
                .map(|v| v.min(100) as i64)
            {
                Some(pct) if pct != last_pct => {
                    progress(done, total);
                    last_pct = pct;
                }
                None => {
                    let mib = done / (1024 * 1024);
                    if mib != last_mib {
                        progress(done, total);
                        last_mib = mib;
                    }
                }
                _ => {}
            }
        }
        // Always emit a final line so completion is visible even if the last
        // chunk didn't cross a pct/MiB boundary.
        progress(done, total);
        Ok(buf)
    }
}

/// All the ways voice resolution can fail. Typed (not stringly) so callers and
/// tests can branch on the variant — e.g. suggest `--voice-path` only when the
/// curated catalog doesn't know the id.
#[derive(Debug, Error)]
pub enum ResolveError {
    /// `--voice-path <model.onnx>` was given but the file doesn't exist.
    #[error("--voice-path `{}` does not exist", .path.display())]
    VoicePathNotFound {
        /// The `.onnx` path the user supplied.
        path: PathBuf,
    },

    /// `--voice-path <model.onnx>` exists but the adjacent `<stem>.json`
    /// config that Piper needs alongside it is missing.
    #[error(
        "--voice-path `{}` has no adjacent `{}` config; Piper needs the .json next to the .onnx",
        .onnx.display(),
        .json.display()
    )]
    MissingJsonSibling {
        /// The `.onnx` path the user supplied (exists).
        onnx: PathBuf,
        /// The expected sibling `.json` path (missing).
        json: PathBuf,
    },

    /// The voice id is not in [`CURATED_VOICES`]; only curated ids resolve to a
    /// download URL. The escape hatch is `--voice-path`.
    #[error(
        "unknown curated voice id `{0}` (not in CURATED_VOICES); pass --voice-path <model.onnx> to use a custom voice"
    )]
    UnknownCuratedId(String),

    /// A cache file could not be written (disk full, permissions, etc.).
    #[error("writing voice cache: {0}")]
    Io(#[from] std::io::Error),

    /// Downloading the voice model from HuggingFace failed. `url` is the
    /// failing URL so the user can verify reachability or fetch manually and
    /// point `--voice-path` at the result.
    #[error("download failed for {url}: {message}")]
    Download {
        /// The URL we tried to fetch.
        url: String,
        /// Underlying error rendered to a string.
        message: String,
    },
}

/// Resolve the effective voice `.onnx` path for a synth/resynth run.
///
/// - If `opts.voice_path` is `Some`, that path is used verbatim (after checking
///   it and its `<stem>.json` sibling exist); the curated catalog and download
///   path are skipped entirely.
/// - Otherwise the voice id (`id.unwrap_or(DEFAULT_VOICE_ID)`) is resolved via
///   the curated catalog. A cache hit (both `.onnx` and `.json` present under
///   `opts.cache_dir`) short-circuits the download. On a miss, both files are
///   fetched via `source` and written to the cache before returning.
///
/// `progress`, when `Some`, renders `voice d.t MiB (pct%)` lines during each
/// download. `None` is silent (e.g. tests that only assert cache behavior).
pub fn resolve_voice(
    id: Option<&str>,
    opts: &ResolveOpts,
    source: &dyn VoiceSource,
    progress: Option<&dyn ProgressSink>,
) -> Result<PathBuf, ResolveError> {
    // Path 1: --voice-path override (offline, no catalog lookup, no download).
    if let Some(onnx) = &opts.voice_path {
        if !onnx.is_file() {
            return Err(ResolveError::VoicePathNotFound { path: onnx.clone() });
        }
        // Piper loads `<stem>.json` from beside the .onnx; pre-check it so the
        // failure mode is a clear message, not piper's opaque error.
        let json = onnx.with_extension("json");
        if !json.is_file() {
            return Err(ResolveError::MissingJsonSibling {
                onnx: onnx.clone(),
                json,
            });
        }
        return Ok(onnx.clone());
    }

    // Path 2: curated-id resolution (cache or download).
    let id = id.unwrap_or(DEFAULT_VOICE_ID);
    let rel_onnx =
        curated_rel_onnx_path(id).ok_or_else(|| ResolveError::UnknownCuratedId(id.to_string()))?;
    let onnx_path = cache_onnx_path(&opts.cache_dir, id);
    let json_path = onnx_path.with_extension("json");

    // Cache hit short-circuits when BOTH files are present. A partial state
    // (only one of the two) is treated as a miss and re-downloaded.
    if onnx_path.is_file() && json_path.is_file() {
        return Ok(onnx_path);
    }

    // Cache miss: ensure the dir exists, then fetch both files.
    fs::create_dir_all(&opts.cache_dir)?;
    let rel_json = rel_onnx
        .strip_suffix(".onnx")
        .expect("curated rel path always ends in .onnx");
    download(source, &hf_url(rel_onnx), &onnx_path, progress)?;
    download(
        source,
        &hf_url(&format!("{rel_json}.json")),
        &json_path,
        progress,
    )?;
    Ok(onnx_path)
}

/// Fetch `url` via `source` and atomically-ish write the bytes to `dest`.
/// `progress`, when `Some`, renders download progress lines as bytes arrive.
/// Failures surface as [`ResolveError::Download`] carrying the failing URL so
/// the user can verify reachability or fall back to `--voice-path`.
fn download(
    source: &dyn VoiceSource,
    url: &str,
    dest: &Path,
    progress: Option<&dyn ProgressSink>,
) -> Result<(), ResolveError> {
    let bytes = source
        .fetch_with_progress(url, &mut |done, total| {
            if let Some(p) = progress {
                p.download_step(done, total);
            }
        })
        .map_err(|e| ResolveError::Download {
            url: url.to_string(),
            message: e.to_string(),
        })?;
    let mut file = fs::File::create(dest)?;
    file.write_all(&bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A [`VoiceSource`] stub that records every URL it was asked to fetch and
    /// returns the URL itself as the body, so tests can assert call order and
    /// cache contents without going online. Bodies don't need to be valid
    /// Piper bytes — only that the bytes round-trip into the cache files.
    #[derive(Default)]
    struct StubSource {
        calls: Mutex<Vec<String>>,
    }

    impl VoiceSource for StubSource {
        fn fetch_with_progress(
            &self,
            url: &str,
            _progress: &mut dyn FnMut(u64, u64),
        ) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
            self.calls.lock().unwrap().push(url.to_string());
            Ok(url.as_bytes().to_vec())
        }
    }

    impl StubSource {
        fn calls_snapshot(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[test]
    fn default_voice_id_matches_first_curated_entry() {
        // Parity with the SPA: DEFAULT_VOICE_ID is CURATED_VOICES[0].id.
        assert_eq!(DEFAULT_VOICE_ID, CURATED_VOICES[0].id);
        assert_eq!(DEFAULT_VOICE_ID, "en_US-hfc_female-medium");
    }

    #[test]
    fn curated_voices_count_is_eight_english_medium() {
        // Parity: 8 entries, all en_US/en_GB, all medium.
        assert_eq!(CURATED_VOICES.len(), 8, "catalog must mirror the SPA's 8");
        for v in CURATED_VOICES {
            assert!(
                v.language == "en_US" || v.language == "en_GB",
                "{} has unexpected language {}",
                v.id,
                v.language
            );
            assert_eq!(
                v.quality,
                VoiceQuality::Medium,
                "{} must be medium (catalog is medium-only)",
                v.id
            );
        }
    }

    #[test]
    fn curated_rel_onnx_paths_match_spa_path_map() {
        // Parity with web/src/lib/tts/vendor/piper/models.ts PATH_MAP entries
        // for the 8 curated voices.
        let expected: &[(&str, &str)] = &[
            (
                "en_US-hfc_female-medium",
                "en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx",
            ),
            (
                "en_US-ryan-medium",
                "en/en_US/ryan/medium/en_US-ryan-medium.onnx",
            ),
            (
                "en_US-amy-medium",
                "en/en_US/amy/medium/en_US-amy-medium.onnx",
            ),
            (
                "en_US-lessac-medium",
                "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
            ),
            (
                "en_US-kristin-medium",
                "en/en_US/kristin/medium/en_US-kristin-medium.onnx",
            ),
            (
                "en_GB-alan-medium",
                "en/en_GB/alan/medium/en_GB-alan-medium.onnx",
            ),
            (
                "en_GB-alba-medium",
                "en/en_GB/alba/medium/en_GB-alba-medium.onnx",
            ),
            (
                "en_GB-cori-medium",
                "en/en_GB/cori/medium/en_GB-cori-medium.onnx",
            ),
        ];
        for (id, rel) in expected {
            assert_eq!(
                curated_rel_onnx_path(id),
                Some(*rel),
                "path map drift for {id}"
            );
        }
        // Non-curated ids (even ones PATH_MAP knows) resolve to None here:
        assert_eq!(curated_rel_onnx_path("en_US-ryan-high"), None);
        assert_eq!(curated_rel_onnx_path("en_US-ryan-low"), None);
    }

    #[test]
    fn hf_url_joins_base_and_rel_path() {
        let url = hf_url("en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx");
        assert_eq!(
            url,
            format!("{HF_BASE}/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx")
        );
    }

    #[test]
    fn voice_path_override_passes_through_and_skips_download() {
        // Given both .onnx and .json exist next to each other:
        let dir = tempfile::tempdir().unwrap();
        let onnx = dir.path().join("my.onnx");
        let json = dir.path().join("my.json");
        std::fs::write(&onnx, b"model").unwrap();
        std::fs::write(&json, b"cfg").unwrap();

        let opts = ResolveOpts::new(Some(onnx.clone()), dir.path().join("cache"));
        let stub = StubSource::default();

        // When --voice-path is set, the voice id is irrelevant.
        let resolved = resolve_voice(Some("en_US-ryan-medium"), &opts, &stub, None).unwrap();
        assert_eq!(resolved, onnx);
        assert!(
            stub.calls_snapshot().is_empty(),
            "--voice-path must short-circuit the network entirely"
        );
    }

    #[test]
    fn voice_path_override_errors_when_onnx_missing() {
        let dir = tempfile::tempdir().unwrap();
        let onnx = dir.path().join("nope.onnx");
        let opts = ResolveOpts::new(Some(onnx.clone()), dir.path().join("cache"));
        let stub = StubSource::default();

        let err = resolve_voice(None, &opts, &stub, None).unwrap_err();
        match err {
            ResolveError::VoicePathNotFound { path } => assert_eq!(path, onnx),
            other => panic!("expected VoicePathNotFound, got {other:?}"),
        }
    }

    #[test]
    fn voice_path_override_errors_when_json_sibling_missing() {
        let dir = tempfile::tempdir().unwrap();
        let onnx = dir.path().join("my.onnx");
        std::fs::write(&onnx, b"model").unwrap();
        // Note: no my.json written.
        let opts = ResolveOpts::new(Some(onnx.clone()), dir.path().join("cache"));
        let stub = StubSource::default();

        let err = resolve_voice(None, &opts, &stub, None).unwrap_err();
        match err {
            ResolveError::MissingJsonSibling { onnx: o, json } => {
                assert_eq!(o, onnx);
                assert_eq!(json, dir.path().join("my.json"));
            }
            other => panic!("expected MissingJsonSibling, got {other:?}"),
        }
    }

    #[test]
    fn curated_cache_hit_short_circuits_download() {
        let cache = tempfile::tempdir().unwrap();
        let id = "en_US-hfc_female-medium";
        // Pre-populate the cache as if a prior run downloaded both files.
        std::fs::write(cache.path().join(format!("{id}.onnx")), b"model").unwrap();
        std::fs::write(cache.path().join(format!("{id}.json")), b"cfg").unwrap();

        let opts = ResolveOpts::new(None, cache.path().to_path_buf());
        let stub = StubSource::default();

        let resolved = resolve_voice(Some(id), &opts, &stub, None).unwrap();
        assert_eq!(resolved, cache.path().join(format!("{id}.onnx")));
        assert!(
            stub.calls_snapshot().is_empty(),
            "cache hit must not touch the network"
        );
    }

    #[test]
    fn curated_miss_downloads_both_files_into_cache() {
        let cache = tempfile::tempdir().unwrap();
        let id = "en_US-ryan-medium";
        let opts = ResolveOpts::new(None, cache.path().to_path_buf());
        let stub = StubSource::default();

        let resolved = resolve_voice(Some(id), &opts, &stub, None).unwrap();

        // The .onnx path is returned and the file exists on disk.
        let onnx_path = cache.path().join(format!("{id}.onnx"));
        let json_path = cache.path().join(format!("{id}.json"));
        assert_eq!(resolved, onnx_path);
        assert!(onnx_path.is_file(), ".onnx should be written to cache");
        assert!(json_path.is_file(), ".json should be written to cache");

        // Both files were fetched from the right HF URLs (one .onnx, one .json).
        let calls = stub.calls_snapshot();
        assert_eq!(calls.len(), 2, "should fetch exactly .onnx + .json");
        let rel = curated_rel_onnx_path(id).unwrap();
        let onnx_url = hf_url(rel);
        let json_url = hf_url(&rel.replace(".onnx", ".json"));
        assert!(calls.contains(&onnx_url), "calls were: {calls:?}");
        assert!(calls.contains(&json_url), "calls were: {calls:?}");

        // The downloaded bytes round-trip into the cache files.
        assert_eq!(std::fs::read(&onnx_path).unwrap(), onnx_url.as_bytes());
        assert_eq!(std::fs::read(&json_path).unwrap(), json_url.as_bytes());
    }

    #[test]
    fn curated_default_voice_when_id_is_none() {
        // When --voice is omitted, DEFAULT_VOICE_ID resolves via the catalog.
        let cache = tempfile::tempdir().unwrap();
        let id = DEFAULT_VOICE_ID;
        std::fs::write(cache.path().join(format!("{id}.onnx")), b"m").unwrap();
        std::fs::write(cache.path().join(format!("{id}.json")), b"c").unwrap();

        let opts = ResolveOpts::new(None, cache.path().to_path_buf());
        let stub = StubSource::default();
        let resolved = resolve_voice(None, &opts, &stub, None).unwrap();
        assert_eq!(resolved, cache.path().join(format!("{id}.onnx")));
    }

    #[test]
    fn unknown_curated_id_returns_typed_error() {
        let cache = tempfile::tempdir().unwrap();
        let opts = ResolveOpts::new(None, cache.path().to_path_buf());
        let stub = StubSource::default();

        let err = resolve_voice(Some("en_US-ryan-high"), &opts, &stub, None).unwrap_err();
        match err {
            ResolveError::UnknownCuratedId(id) => {
                assert_eq!(id, "en_US-ryan-high");
            }
            other => panic!("expected UnknownCuratedId, got {other:?}"),
        }
        // No download should have been attempted.
        assert!(stub.calls_snapshot().is_empty());
    }

    #[test]
    fn find_curated_looks_up_by_id() {
        assert_eq!(
            find_curated("en_US-hfc_female-medium").map(|v| v.name),
            Some("HFC Female")
        );
        assert_eq!(find_curated("en_US-ryan-high"), None);
    }

    /// A clonable `Write` that records into a shared buffer, so a test can read
    /// what `Progress` wrote while the sink owns the box.
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

    /// A stub source that simulates a 2 MiB download in two 1 MiB chunks,
    /// invoking the progress callback at 50% then 100%. Exercises the
    /// `fetch_with_progress` → `download` → `Progress::download_step` path
    /// without going online.
    #[derive(Default)]
    struct StreamingStub;

    impl VoiceSource for StreamingStub {
        fn fetch_with_progress(
            &self,
            url: &str,
            progress: &mut dyn FnMut(u64, u64),
        ) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
            let total: u64 = 2 * 1024 * 1024;
            progress(total / 2, total);
            progress(total, total);
            Ok(url.as_bytes().to_vec())
        }
    }

    #[test]
    fn cache_miss_emits_download_progress_lines_per_file() {
        // A cache miss fetches both .onnx + .json; each emits 50% then 100%.
        let cache = tempfile::tempdir().unwrap();
        let id = "en_US-ryan-medium";
        let opts = ResolveOpts::new(None, cache.path().to_path_buf());

        let captured = Captured::default();
        let progress = crate::progress::Progress::new(Box::new(captured.clone()));

        resolve_voice(Some(id), &opts, &StreamingStub, Some(&progress)).unwrap();

        // Two files, two progress callbacks each → four lines, repeated twice.
        assert_eq!(
            captured.take(),
            "voice 1.0/2.0 MiB (50%)\n\
             voice 2.0/2.0 MiB (100%)\n\
             voice 1.0/2.0 MiB (50%)\n\
             voice 2.0/2.0 MiB (100%)\n"
        );
    }

    #[test]
    fn cache_hit_emits_no_download_progress() {
        // Pre-populate the cache so no fetch happens → no progress lines.
        let cache = tempfile::tempdir().unwrap();
        let id = "en_US-hfc_female-medium";
        std::fs::write(cache.path().join(format!("{id}.onnx")), b"m").unwrap();
        std::fs::write(cache.path().join(format!("{id}.json")), b"c").unwrap();
        let opts = ResolveOpts::new(None, cache.path().to_path_buf());

        let captured = Captured::default();
        let progress = crate::progress::Progress::new(Box::new(captured.clone()));

        resolve_voice(Some(id), &opts, &StreamingStub, Some(&progress)).unwrap();

        assert_eq!(captured.take(), "", "cache hit must emit no download lines");
    }

    #[test]
    fn voice_path_override_emits_no_download_progress() {
        // --voice-path short-circuits the network entirely → no progress lines.
        let dir = tempfile::tempdir().unwrap();
        let onnx = dir.path().join("my.onnx");
        let json = dir.path().join("my.json");
        std::fs::write(&onnx, b"model").unwrap();
        std::fs::write(&json, b"cfg").unwrap();
        let opts = ResolveOpts::new(Some(onnx.clone()), dir.path().join("cache"));

        let captured = Captured::default();
        let progress = crate::progress::Progress::new(Box::new(captured.clone()));

        let resolved = resolve_voice(None, &opts, &StreamingStub, Some(&progress)).unwrap();
        assert_eq!(resolved, onnx);
        assert_eq!(
            captured.take(),
            "",
            "--voice-path must emit no download lines"
        );
    }
}
