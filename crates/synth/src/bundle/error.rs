//! Typed errors for bundle read/write.

use thiserror::Error;

/// All ways bundle I/O can fail. Typed (not stringly) so callers can branch on
/// e.g. [`BundleError::UnknownSchema`] to surface "upgrade your app" copy.
#[derive(Debug, Error)]
pub enum BundleError {
    /// The bundle's `schemaVersion` is not one this reader supports. `found`
    /// is the bundle's version; `supported` is this reader's version.
    #[error("unsupported bundle schema version {found}; this reader supports {supported}")]
    UnknownSchema {
        /// Version found in the bundle manifest.
        found: u32,
        /// Highest version this reader understands.
        supported: u32,
    },

    /// A required entry (`manifest.json`, `text.json`) is missing.
    #[error("missing bundle entry: {0}")]
    MissingEntry(&'static str),

    /// The archive itself is corrupt or unreadable.
    #[error("corrupt bundle archive: {0}")]
    Zip(#[from] zip::result::ZipError),

    /// A JSON entry failed to parse.
    #[error("corrupt bundle JSON: {0}")]
    Json(#[from] serde_json::Error),

    /// An I/O error reading or writing bytes.
    #[error("bundle I/O: {0}")]
    Io(#[from] std::io::Error),

    /// An archive entry's decompressed size exceeded the per-entry cap. The
    /// compressed archive can be tiny while inflating to gigabytes (deflate
    /// amplifies ~1000×), so reads are budgeted — see `io::ReadBudget`.
    #[error("bundle entry {name:?} decompresses beyond the per-entry cap of {limit} bytes")]
    EntryTooLarge {
        /// The offending entry's archive name.
        name: String,
        /// The per-entry cap that was exceeded.
        limit: u64,
    },

    /// The summed decompressed size of an archive's entries exceeded the total
    /// budget — a crafted (zip-of-zips) archive, or simply an enormous library.
    #[error("bundle contents decompress beyond the total budget of {limit} bytes")]
    TotalTooLarge {
        /// The archive-level budget that was exceeded.
        limit: u64,
    },
}
