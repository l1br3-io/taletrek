//! The reader screen (effort `desktop-reader-page`): opens a `.taletrek`
//! bundle, renders its chapters, and plays its audio paragraph-synced.
//!
//! Layering invariant: cpal and the opus/ogg decode crates never appear
//! outside [`audio`] — the sequencing core under `crates/reader` (task 002)
//! must stay importable without either. Task 004 adds the UI-free open
//! flow ([`session`]) and the egui screen ([`view`]); egui types stay
//! confined to `view.rs` within this tree, per the shell's rule.

pub mod audio;
pub mod session;
pub mod view;
