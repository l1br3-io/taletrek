//! TaleTrek reader core — manifest + chapter text in, a navigable book out.
//!
//! This crate is the kernel's read side: it turns what [`taletrek_synth`]
//! reads out of a `.taletrek` bundle (manifest + chapter text) into the
//! pure, navigable model ([`BookIndex`]) that readers render and sequence
//! against. [`PlayerState`] adds the pure playback sequencer on top —
//! under the platform contract (see `state`'s module docs) the kernel
//! decides what plays next and where you are, while each platform maps
//! its player callbacks onto [`PlayerEvent`]s and executes the returned
//! [`PlayerAction`]s. The desktop app is the first consumer, with
//! Android and iOS consuming the same core via UniFFI — the desktop is a
//! consumer, not the owner.
//!
//! The API mirrors `taletrek-parse`'s discipline: plain data in, plain data
//! out — no I/O, audio hardware, or UI, `String` ids, UniFFI-exposable
//! shapes. The one derivation this crate owns is the paragraph→segment-key
//! mapping: each paragraph's key comes from the same
//! [`taletrek_synth::cache_key`] the writer keyed its segments by, so reader
//! and writer cannot drift (pinned by `tests/anti_drift.rs`).

mod index;
mod position;
mod state;

pub use index::{BookIndex, ChapterIndex, ParagraphIndex};
pub use position::Position;
pub use state::{FailureLog, ParagraphPos, PlayerAction, PlayerEvent, PlayerState};
