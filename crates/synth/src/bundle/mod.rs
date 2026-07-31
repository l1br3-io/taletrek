//! Bundle entry-point: in-memory model + submodule wiring.

pub mod audio;
pub mod error;
pub mod io;
pub mod library;
pub mod manifest;
pub mod text;

pub use audio::{AudioCodec, AudioSegment};

use std::collections::HashMap;

use manifest::Manifest;
use text::ChapterText;

/// In-memory representation of a single `.taletrek` book bundle.
///
/// A bundle may be **text-only** (`audio` empty, `manifest.audio.present ==
/// false`) or **full** (audio segments present). Both travel in the same
/// container; see [`crate`] docs and `docs/bundle-format.md`.
#[derive(Debug, Clone)]
pub struct BookBundle {
    /// Bundle manifest (versioned, book metadata, audio descriptor).
    pub manifest: Manifest,
    /// Cleaned chapter structure (mirrors the SPA `Chapter` type).
    pub chapters: Vec<ChapterText>,
    /// Content-addressed audio segments, keyed by cache key. Empty when the
    /// bundle is text-only.
    pub audio: HashMap<String, AudioSegment>,
}

pub use library::{LibraryBundle, LibraryEntry};
