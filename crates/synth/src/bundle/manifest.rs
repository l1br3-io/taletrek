//! Bundle manifest model — `manifest.json` inside a `.taletrek` archive.

use serde::{Deserialize, Serialize};

use super::audio::AudioCodec;

/// Bundle format schema version. Readers refuse a mismatched major version with
/// [`crate::BundleError::UnknownSchema`]. Additive optional fields do not bump
/// this; a bump means "older readers cannot safely load this."
pub const SCHEMA_VERSION: u32 = 1;

/// Top-level manifest of a book bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Format schema version (see [`SCHEMA_VERSION`]).
    pub schema_version: u32,
    /// Discriminator — always `book` for a single-book bundle.
    pub kind: ManifestKind,
    /// Book metadata.
    pub book: BookMeta,
    /// Audio descriptor (present/absent + codec).
    pub audio: AudioMeta,
    /// Which app produced this bundle.
    pub generator: Generator,
}

/// Bundle kind discriminator. v1 has only `Book`; `Library` lives in the
/// library manifest (`bundle/library.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManifestKind {
    /// A single-book bundle.
    Book,
}

/// Book-level metadata, mirrored into the SPA's `Book` record on import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMeta {
    /// TaleTrek `BookId` (branded string). New on import if absent/colliding.
    pub id: String,
    /// Book title.
    pub title: String,
    /// Author, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Source format the book was parsed from: `pdf`/`epub`/`mobi`/`txt`/`md`/`unknown`.
    pub source_format: String,
    /// Number of chapters.
    pub chapter_count: u32,
    /// Voice id used for synthesis (present even on text-only bundles so the
    /// intended voice is preserved across export→synth→import).
    pub voice_id: String,
    /// Creation time, ms since epoch.
    pub created_at: u64,
    /// Last-update time, ms since epoch.
    pub updated_at: u64,
    /// Reading progress fraction 0..1, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_fraction: Option<f64>,
}

/// Descriptor of the bundle's audio payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeta {
    /// `false` (or no `audio/` entries) ⇒ text-only (pre-synth) bundle.
    pub present: bool,
    /// Codec of the segments.
    pub codec: AudioCodec,
    /// Normalization version the cache keys were derived under.
    pub norm_version: u32,
    /// Number of audio segments in `audio/`.
    pub segment_count: u32,
}

/// Which app generated this bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generator {
    /// Producing app id — `taletrek-desktop` (CLI) today; the desktop GUI and
    /// mobile apps stamp their own ids via the same seam. Historical bundles
    /// may carry `taletrek-spa` or `taletrek-server`.
    pub app: String,
    /// App version.
    pub version: String,
}
