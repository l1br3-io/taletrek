//! The reader screen (effort `desktop-reader-page`): opens a `.taletrek`
//! bundle, renders its chapters, and plays its audio paragraph-synced.
//!
//! Layering invariant: cpal and the opus/ogg decode crates never appear
//! outside [`audio`] — the sequencing core under `crates/reader` (task 002)
//! must stay importable without either.

pub mod audio;
