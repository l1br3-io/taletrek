//! [`FfiError`] — [`BundleError`] as data foreign callers can branch on.
//!
//! Field-for-field over `taletrek-synth`'s typed error (the stringified
//! detail boxes exist because the source variants carry `#[source]`-only
//! types UniFFI cannot carry). Display mirrors the kernel's messages so
//! logs read identically on every platform.

use std::fmt;

use taletrek_synth::BundleError;

/// All ways a bundle open/read can fail over the FFI surface.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error)]
pub enum FfiError {
    /// The bundle's `schemaVersion` is not one this reader supports —
    /// surface "upgrade your app" copy.
    UnknownSchema {
        /// Version found in the bundle manifest.
        found: u32,
        /// Highest version this reader understands.
        supported: u32,
    },
    /// A required entry (`manifest.json`, `text.json`) is missing.
    MissingEntry {
        /// The absent entry's name.
        entry: String,
    },
    /// The archive itself is corrupt or unreadable.
    CorruptArchive {
        /// The underlying zip failure, stringified.
        detail: String,
    },
    /// A JSON entry failed to parse.
    CorruptJson {
        /// The underlying parse failure, stringified.
        detail: String,
    },
    /// An I/O error reading the bytes.
    Io {
        /// The underlying I/O failure, stringified.
        detail: String,
    },
    /// An archive entry's decompressed size exceeded the per-entry cap.
    EntryTooLarge {
        /// The offending entry's archive name.
        name: String,
        /// The per-entry cap that was exceeded.
        limit: u64,
    },
    /// An audio content key is not a safe single name component —
    /// rejected before any archive lookup.
    InvalidAudioKey {
        /// The rejected key.
        key: String,
    },
    /// The summed decompressed size of an archive's entries exceeded the
    /// total budget.
    TotalTooLarge {
        /// The archive-level budget that was exceeded.
        limit: u64,
    },
    /// An audio segment's bytes could not be decoded to PCM (not
    /// OGG/Opus or 16-bit PCM WAV, or corrupt within its codec) — the
    /// platform maps this onto the kernel's segment-skip path.
    DecodeFailed {
        /// The underlying decode failure, one sentence.
        detail: String,
    },
    /// A whole-book audio merge (export) failed: the bundle is text-only,
    /// its codec is not Opus, or a segment's OGG payload is malformed —
    /// the host surfaces this as "export failed" copy, never a crash.
    MergeFailed {
        /// The underlying merge failure, one sentence.
        detail: String,
    },
}

impl From<BundleError> for FfiError {
    fn from(err: BundleError) -> Self {
        match err {
            BundleError::UnknownSchema { found, supported } => {
                Self::UnknownSchema { found, supported }
            }
            BundleError::MissingEntry(entry) => Self::MissingEntry {
                entry: entry.to_string(),
            },
            BundleError::Zip(e) => Self::CorruptArchive {
                detail: e.to_string(),
            },
            BundleError::Json(e) => Self::CorruptJson {
                detail: e.to_string(),
            },
            BundleError::Io(e) => Self::Io {
                detail: e.to_string(),
            },
            BundleError::EntryTooLarge { name, limit } => Self::EntryTooLarge { name, limit },
            BundleError::InvalidAudioKey(key) => Self::InvalidAudioKey { key },
            BundleError::TotalTooLarge { limit } => Self::TotalTooLarge { limit },
        }
    }
}

impl fmt::Display for FfiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSchema { found, supported } => write!(
                f,
                "unsupported bundle schema version {found}; this reader supports {supported}"
            ),
            Self::MissingEntry { entry } => write!(f, "missing bundle entry: {entry}"),
            Self::CorruptArchive { detail } => write!(f, "corrupt bundle archive: {detail}"),
            Self::CorruptJson { detail } => write!(f, "corrupt bundle JSON: {detail}"),
            Self::Io { detail } => write!(f, "bundle I/O: {detail}"),
            Self::EntryTooLarge { name, limit } => write!(
                f,
                "bundle entry {name:?} decompresses beyond the per-entry cap of {limit} bytes"
            ),
            Self::InvalidAudioKey { key } => write!(
                f,
                "invalid audio key {key:?}: must be non-empty and must not contain path separators, '..', or NUL"
            ),
            Self::TotalTooLarge { limit } => write!(
                f,
                "bundle contents decompress beyond the total budget of {limit} bytes"
            ),
            Self::DecodeFailed { detail } => write!(f, "segment decode failed: {detail}"),
            Self::MergeFailed { detail } => write!(f, "audio merge failed: {detail}"),
        }
    }
}

impl std::error::Error for FfiError {}
