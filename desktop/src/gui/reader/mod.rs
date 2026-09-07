//! The reader screen (effort `desktop-reader-page`): opens a `.taletrek`
//! bundle, renders its chapters, and plays its audio paragraph-synced.
//!
//! Layering invariant: cpal and the opus/ogg decode crates never appear
//! outside [`audio`] — the sequencing core under `crates/reader` (task 002)
//! must stay importable without either. Task 004 added the UI-free open
//! flow ([`session`]) and the egui screen ([`view`]); task 005 wired
//! playback: [`playback`] is the UI-free controller that runs the kernel
//! `PlayerState` machine over the [`audio`] engine. egui types stay
//! confined to `view.rs` within this tree, per the shell's rule; task
//! 006's sync-UX decision helpers ([`scroll`]) are pure and egui-free.

pub mod audio;
pub mod playback;
pub mod scroll;
pub mod session;
pub mod view;
