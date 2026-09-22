//! The global content-addressed segment store — the kernel's reusable synth
//! output across books, runs, and crashes (`progressive-synth` task 004).
//!
//! # Layout
//!
//! One directory (hosts open `<cache>/taletrek/segments`), 2-level prefix
//! sharded on the key's **last two characters**:
//! `<dir>/<key-tail-2>/<key>.<codec-ext>`. The tail (not the head — the
//! obvious scheme) is the shard source because cache keys are
//! `voice:NORM_VERSION:sha256`: the head is a voice id, so head-sharding
//! would give every segment of a voice one giant dir; the tail is uniform
//! sha256 hex. Segment bytes are the encoded audio, raw; the codec survives
//! in the file extension (`AudioCodec::ext` / `from_ext`).
//!
//! # Invariants (the contract tasks 005–007 build on)
//!
//! - **Atomicity**: `put` writes a same-dir temp then renames — a reader
//!   (`get`/`keys`/`size_bytes`) never observes a partial segment, and a
//!   crash mid-write leaves only a `.tmp` orphan. `open` sweeps orphan
//!   temps from previous crashed runs.
//! - **LRU**: eviction is least-recently-used by file mtime, touched on
//!   `put` and on `get` (touch-on-access) — no sidecar index; the filesystem
//!   is the index, so a crash can't desynchronize it. Ties break by key for
//!   determinism.
//! - **The store never holds bundles**: only segments, so "sealed bundles
//!   are never evicted" holds by construction — eviction can only remove
//!   store files, never a sealed `.taletrek`.
//! - Keys are validated (`taletrek_synth::validate_audio_key`) before any
//!   filesystem contact — a malformed key is a typed error, never a path
//!   traversal.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use thiserror::Error;

use taletrek_synth::{validate_audio_key, AudioCodec, AudioSegment};

/// All the ways store operations can fail. Typed so hosts can branch (a
/// corrupt read vs. a full disk vs. a bad key) and `?` lifts into `anyhow`.
#[derive(Debug, Error)]
pub enum StoreError {
    /// The filesystem rejected an operation (create/read/write/rename/
    /// remove/metadata). Carries the path for actionable messages.
    #[error("segment store I/O on {path}: {source}")]
    Io {
        /// The store path involved.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },

    /// A key failed [`taletrek_synth::validate_audio_key`] — never touch
    /// the filesystem with it.
    #[error("invalid segment key {key:?}: {reason}")]
    InvalidKey {
        /// The rejected key.
        key: String,
        /// Why (the validator's message).
        reason: String,
    },

    /// A store file's extension doesn't map to a known codec — the file was
    /// renamed or the store was tampered with.
    #[error("unknown codec extension for segment {key}: {ext}")]
    UnknownCodec {
        /// The key whose file carries the unknown extension.
        key: String,
        /// The offending extension.
        ext: String,
    },
}

/// The content-addressed segment store over one directory. All methods take
/// `&self` — safe to share across threads; per-file operations are
/// individually atomic (rename/mtime), and eviction only removes store
/// files.
#[derive(Debug, Clone)]
pub struct SegmentStore {
    dir: PathBuf,
}

impl SegmentStore {
    /// Open (and create if missing) the store rooted at `dir`, sweeping
    /// orphan `.tmp` files left by crashed writes.
    pub fn open(dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(|source| StoreError::Io {
            path: dir.to_path_buf(),
            source,
        })?;
        let store = Self {
            dir: dir.to_path_buf(),
        };
        store.sweep_temps()?;
        Ok(store)
    }

    /// Store `seg` under its key atomically: same-dir temp + rename. The
    /// file's mtime is the access time (write = touch).
    pub fn put(&self, seg: &AudioSegment) -> Result<(), StoreError> {
        Self::validate(seg.key.as_str())?;
        let path = self.segment_path(&seg.key, &seg.codec);
        let shard = self.shard_dir(seg.key.as_str());
        std::fs::create_dir_all(&shard).map_err(|source| StoreError::Io {
            path: shard.clone(),
            source,
        })?;
        let tmp = shard.join(format!(".{}.{}.tmp", seg.key, std::process::id()));
        std::fs::write(&tmp, &seg.bytes).map_err(|source| StoreError::Io {
            path: tmp.clone(),
            source,
        })?;
        std::fs::rename(&tmp, &path).map_err(|source| StoreError::Io {
            path: path.clone(),
            source,
        })?;
        Ok(())
    }

    /// Read a segment back (bytes + codec), or `None` when absent. A hit
    /// touches the file's mtime — LRU is access-ordered.
    pub fn get(&self, key: &str) -> Result<Option<AudioSegment>, StoreError> {
        Self::validate(key)?;
        let Some((path, codec)) = self.find(key)? else {
            return Ok(None);
        };
        let bytes = std::fs::read(&path).map_err(|source| StoreError::Io {
            path: path.clone(),
            source,
        })?;
        self.set_modified(&path, SystemTime::now())?;
        Ok(Some(AudioSegment {
            key: key.to_string(),
            codec,
            bytes,
        }))
    }

    /// Whether the key is present (no touch).
    pub fn contains(&self, key: &str) -> Result<bool, StoreError> {
        Self::validate(key)?;
        Ok(self.find(key)?.is_some())
    }

    /// Every completed key in the store, sorted (resume planning input).
    /// Temps are never included.
    pub fn keys(&self) -> Result<Vec<String>, StoreError> {
        let mut keys = Vec::new();
        self.visit_segments(|key, _path, _len, _mtime| {
            keys.push(key.to_string());
        })?;
        keys.sort_unstable();
        Ok(keys)
    }

    /// Evict least-recently-used segments (by mtime, oldest first) until
    /// the store holds ≤ `cap_bytes`. A cap at/above the current size is a
    /// no-op; zero evicts everything.
    pub fn evict_to_cap(&self, cap_bytes: u64) -> Result<(), StoreError> {
        let mut entries: Vec<(String, PathBuf, u64, SystemTime)> = Vec::new();
        self.visit_segments(|key, path, len, mtime| {
            entries.push((key.to_string(), path.to_path_buf(), len, mtime));
        })?;
        let total: u64 = entries.iter().map(|(_, _, len, _)| len).sum();
        if total <= cap_bytes {
            return Ok(());
        }
        // LRU first; key-ascending tie break keeps eviction deterministic.
        entries.sort_by(|a, b| a.3.cmp(&b.3).then_with(|| a.0.cmp(&b.0)));
        let mut total = total;
        for (_, path, len, _) in entries {
            if total <= cap_bytes {
                break;
            }
            std::fs::remove_file(&path).map_err(|source| StoreError::Io {
                path: path.clone(),
                source,
            })?;
            total -= len;
        }
        Ok(())
    }

    /// Total bytes of completed segments (temps excluded).
    pub fn size_bytes(&self) -> Result<u64, StoreError> {
        let mut total = 0u64;
        self.visit_segments(|_key, _path, len, _mtime| {
            total += len;
        })?;
        Ok(total)
    }

    /// Set a key's access time (its file's mtime) — the LRU seam. Production
    /// code touches with `SystemTime::now()` inside `get`/`put`; hosts and
    /// tests may pin times explicitly to make eviction order deterministic.
    pub fn set_accessed(&self, key: &str, at: SystemTime) -> Result<(), StoreError> {
        Self::validate(key)?;
        let Some((path, _codec)) = self.find(key)? else {
            return Ok(());
        };
        self.set_modified(&path, at)
    }

    // ---- internals ----

    /// Reject a malformed key before any filesystem contact.
    fn validate(key: &str) -> Result<(), StoreError> {
        validate_audio_key(key).map_err(|e| StoreError::InvalidKey {
            key: key.to_string(),
            reason: e.to_string(),
        })
    }

    /// The shard dir for `key`: the key's last two characters (sha256 hex
    /// in real keys — uniform; the head is a voice id — see module docs).
    fn shard_dir(&self, key: &str) -> PathBuf {
        let start = key.len().saturating_sub(2);
        let tail = &key[start..];
        self.dir.join(tail)
    }

    /// The final resting path for `(key, codec)`.
    fn segment_path(&self, key: &str, codec: &AudioCodec) -> PathBuf {
        self.shard_dir(key).join(format!("{key}.{}", codec.ext()))
    }

    /// Locate a key's file, trying each known codec extension. `None` when
    /// absent.
    fn find(&self, key: &str) -> Result<Option<(PathBuf, AudioCodec)>, StoreError> {
        for codec in [AudioCodec::Opus, AudioCodec::Wav, AudioCodec::M4a] {
            let path = self.segment_path(key, &codec);
            if path.is_file() {
                return Ok(Some((path, codec)));
            }
        }
        Ok(None)
    }

    /// Set a file's mtime (open for write + `set_modified`).
    fn set_modified(&self, path: &Path, at: SystemTime) -> Result<(), StoreError> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|source| StoreError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        file.set_modified(at).map_err(|source| StoreError::Io {
            path: path.to_path_buf(),
            source,
        })
    }

    /// Walk every shard's completed segments, invoking `f(key, path, len,
    /// mtime)` for each. Skips temps and unknown extensions; shard-internal
    /// errors surface immediately.
    fn visit_segments(
        &self,
        mut f: impl FnMut(&str, &Path, u64, SystemTime),
    ) -> Result<(), StoreError> {
        let shards = std::fs::read_dir(&self.dir).map_err(|source| StoreError::Io {
            path: self.dir.clone(),
            source,
        })?;
        for shard in shards {
            let shard = shard.map_err(|source| StoreError::Io {
                path: self.dir.clone(),
                source,
            })?;
            let shard_path = shard.path();
            if !shard_path.is_dir() {
                continue;
            }
            let files = std::fs::read_dir(&shard_path).map_err(|source| StoreError::Io {
                path: shard_path.clone(),
                source,
            })?;
            for file in files {
                let file = file.map_err(|source| StoreError::Io {
                    path: shard_path.clone(),
                    source,
                })?;
                let path = file.path();
                if !path.is_file() {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let Some(dot) = name.rfind('.') else {
                    continue;
                };
                let (stem, ext) = (&name[..dot], &name[dot + 1..]);
                if AudioCodec::from_ext(ext).is_none() {
                    continue; // temps + foreign files
                }
                let meta = file.metadata().map_err(|source| StoreError::Io {
                    path: path.clone(),
                    source,
                })?;
                let mtime = meta.modified().map_err(|source| StoreError::Io {
                    path: path.clone(),
                    source,
                })?;
                f(stem, &path, meta.len(), mtime);
            }
        }
        Ok(())
    }

    /// Remove every `.tmp` file under the store (crashed writes).
    fn sweep_temps(&self) -> Result<(), StoreError> {
        let shards = std::fs::read_dir(&self.dir).map_err(|source| StoreError::Io {
            path: self.dir.clone(),
            source,
        })?;
        for shard in shards {
            let shard = shard.map_err(|source| StoreError::Io {
                path: self.dir.clone(),
                source,
            })?;
            let shard_path = shard.path();
            if !shard_path.is_dir() {
                continue;
            }
            let files = std::fs::read_dir(&shard_path).map_err(|source| StoreError::Io {
                path: shard_path.clone(),
                source,
            })?;
            for file in files {
                let file = file.map_err(|source| StoreError::Io {
                    path: shard_path.clone(),
                    source,
                })?;
                let path = file.path();
                if path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("tmp"))
                {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal segment with arbitrary bytes under `key`.
    fn seg(key: &str, bytes: &[u8]) -> AudioSegment {
        AudioSegment {
            key: key.to_string(),
            codec: AudioCodec::Opus,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn open_creates_the_store_dir_and_round_trips_segments() {
        let dir = tempfile::tempdir().unwrap();
        let store = SegmentStore::open(dir.path()).unwrap();
        assert!(dir.path().is_dir(), "open creates the root");

        store.put(&seg("voiceA:1:aaaa", &[1, 2, 3])).unwrap();
        store
            .put(&AudioSegment {
                key: "voiceA:1:bbbb".into(),
                codec: AudioCodec::Wav,
                bytes: vec![9, 8, 7, 6],
            })
            .unwrap();

        let got = store.get("voiceA:1:aaaa").unwrap().expect("present");
        assert_eq!(got.bytes, vec![1, 2, 3]);
        assert_eq!(got.codec, AudioCodec::Opus);
        assert_eq!(got.key, "voiceA:1:aaaa");

        let got = store.get("voiceA:1:bbbb").unwrap().expect("present");
        assert_eq!(got.codec, AudioCodec::Wav, "codec survives the extension");
        assert_eq!(got.bytes, vec![9, 8, 7, 6]);

        assert!(store.get("voiceA:1:missing").unwrap().is_none());
        assert!(store.contains("voiceA:1:aaaa").unwrap());
        assert!(!store.contains("voiceA:1:missing").unwrap());
    }

    #[test]
    fn keys_reflect_exactly_the_completed_puts_no_temps() {
        let dir = tempfile::tempdir().unwrap();
        let store = SegmentStore::open(dir.path()).unwrap();
        store.put(&seg("voiceA:1:aaaa", &[1])).unwrap();
        store.put(&seg("voiceB:1:bbbb", &[2])).unwrap();

        // A crashed write's orphan temp: same shard, `.tmp` suffix.
        let shard = dir.path().join("aa");
        std::fs::write(shard.join("voiceA:1:zzzz.opus.tmp"), b"partial").unwrap();

        let keys = store.keys().unwrap();
        assert_eq!(keys, vec!["voiceA:1:aaaa", "voiceB:1:bbbb"]);
    }

    #[test]
    fn a_partial_temp_is_never_returned_and_open_sweeps_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let store = SegmentStore::open(dir.path()).unwrap();

        // Simulate an interrupted put: the temp exists, the final doesn't.
        let shard = dir.path().join("cc");
        std::fs::create_dir_all(&shard).unwrap();
        std::fs::write(shard.join("voiceA:1:cccc.opus.tmp"), b"partial bytes").unwrap();

        assert!(
            store.get("voiceA:1:cccc").unwrap().is_none(),
            "a partial temp must never surface as a segment"
        );
        assert!(!store.contains("voiceA:1:cccc").unwrap());
        assert!(store.keys().unwrap().is_empty());
        assert_eq!(store.size_bytes().unwrap(), 0);

        // Reopening sweeps the orphan.
        let store = SegmentStore::open(dir.path()).unwrap();
        assert!(
            !shard.join("voiceA:1:cccc.opus.tmp").exists(),
            "open sweeps orphan temps"
        );
        assert!(store.keys().unwrap().is_empty());
    }

    #[test]
    fn eviction_removes_least_recently_used_first_and_touch_on_get_survives() {
        let dir = tempfile::tempdir().unwrap();
        let store = SegmentStore::open(dir.path()).unwrap();
        let a = seg("voiceA:1:aaaa", &[1; 10]);
        let b = seg("voiceA:1:bbbb", &[2; 10]);
        let c = seg("voiceA:1:cccc", &[3; 10]);
        store.put(&a).unwrap();
        store.put(&b).unwrap();
        store.put(&c).unwrap();
        assert_eq!(store.size_bytes().unwrap(), 30);

        // Deterministic access order via explicit mtimes: B is oldest, then
        // A (touched by a get), then C (newest put).
        let t_old = SystemTime::UNIX_EPOCH;
        store.set_accessed("voiceA:1:bbbb", t_old).unwrap();
        store
            .set_accessed(
                "voiceA:1:aaaa",
                t_old + std::time::Duration::from_secs(1000),
            )
            .unwrap();
        store
            .set_accessed(
                "voiceA:1:cccc",
                t_old + std::time::Duration::from_secs(2000),
            )
            .unwrap();

        // Cap 25: one 10-byte segment must go — B (LRU).
        store.evict_to_cap(25).unwrap();
        assert!(!store.contains("voiceA:1:bbbb").unwrap(), "LRU evicted");
        assert!(store.contains("voiceA:1:aaaa").unwrap());
        assert!(store.contains("voiceA:1:cccc").unwrap());
        assert_eq!(store.size_bytes().unwrap(), 20);

        // A get counts as access: touch A, then cap 15 evicts C (now LRU).
        store.get("voiceA:1:aaaa").unwrap();
        // Pin the touch deterministically past C's mtime.
        store
            .set_accessed(
                "voiceA:1:aaaa",
                t_old + std::time::Duration::from_secs(3000),
            )
            .unwrap();
        store.evict_to_cap(15).unwrap();
        assert!(
            store.contains("voiceA:1:aaaa").unwrap(),
            "recently used survives"
        );
        assert!(!store.contains("voiceA:1:cccc").unwrap());
        assert_eq!(store.size_bytes().unwrap(), 10);

        // Cap 0 evicts everything; a no-op cap stays put.
        store.evict_to_cap(0).unwrap();
        assert!(store.keys().unwrap().is_empty());
        store.put(&a).unwrap();
        store.evict_to_cap(10_000).unwrap();
        assert_eq!(store.keys().unwrap(), vec!["voiceA:1:aaaa"]);
    }

    #[test]
    fn many_keys_land_across_multiple_shard_dirs_and_lookup_is_unaffected() {
        let dir = tempfile::tempdir().unwrap();
        let store = SegmentStore::open(dir.path()).unwrap();
        // 64 keys with varied sha-tails under one voice — the tail shards
        // them (head-sharding would put all in one dir).
        for i in 0..64u32 {
            let tail = format!("{i:02x}");
            let key = format!("voiceA:1:{tail}");
            store.put(&seg(&key, &[i as u8])).unwrap();
        }
        let shard_count = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().path().is_dir())
            .count();
        assert!(
            shard_count >= 2,
            "keys must distribute across shards, got {shard_count}"
        );
        let got = store.get("voiceA:1:2a").unwrap().expect("present");
        assert_eq!(got.bytes, vec![0x2a]);
        assert_eq!(store.keys().unwrap().len(), 64);
    }

    #[test]
    fn invalid_keys_are_rejected_before_any_filesystem_contact() {
        let dir = tempfile::tempdir().unwrap();
        let store = SegmentStore::open(dir.path()).unwrap();
        let bad = "../escape";
        let err = store.put(&seg(bad, &[1])).unwrap_err();
        assert!(matches!(err, StoreError::InvalidKey { .. }), "got {err:?}");
        assert!(store.get(bad).is_err());
        assert!(store.contains(bad).is_err());
        assert!(store.keys().unwrap().is_empty(), "nothing was written");
    }

    #[test]
    fn eviction_tie_breaks_by_key_for_determinism() {
        // Equal mtimes: eviction order is key-ascending, so repeated runs
        // on the same store pick the same victim.
        let dir = tempfile::tempdir().unwrap();
        let store = SegmentStore::open(dir.path()).unwrap();
        store.put(&seg("voiceA:1:bbbb", &[1; 10])).unwrap();
        store.put(&seg("voiceA:1:aaaa", &[1; 10])).unwrap();
        let t = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(5000);
        store.set_accessed("voiceA:1:aaaa", t).unwrap();
        store.set_accessed("voiceA:1:bbbb", t).unwrap();
        store.evict_to_cap(10).unwrap();
        assert!(
            !store.contains("voiceA:1:aaaa").unwrap(),
            "tie evicts the lexicographically-first key"
        );
        assert!(store.contains("voiceA:1:bbbb").unwrap());
    }
}
