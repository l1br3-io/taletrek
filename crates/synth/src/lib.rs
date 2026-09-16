//! TaleTrek reusable synthesis pipeline + portable bundle I/O.
//!
//! This crate is the shared core between the desktop synth app and the personal
//! server (ADR-0013). It does **not** parse raw files — it ingests *text* (from
//! a bundle) and produces audio. The SPA keeps its own TypeScript pipeline; the
//! two sides agree on the portable bundle format ([`bundle`]) and on the
//! content-addressed cache key ([`cache_key`]).
//!
//! The single most parity-critical invariant is that [`cache_key`] produces the
//! *exact same string* the SPA's `audioCacheKey` produces for the same input,
//! so audio deduplicates across apps. See `tests/cache_key_parity.rs`.
//!
//! The synthesis entry point is [`synthesize_paragraph`], which wires the
//! normalize → split → Piper → concat-WAV → encode pipeline behind injectable
//! [`PiperRunner`] and [`Encoder`] traits.

pub mod bundle;
pub mod cache_key;
pub mod encode;
#[cfg(feature = "native-encode")]
pub mod merge;
pub mod normalize;
#[cfg(feature = "native-encode")]
pub mod opus_native;
pub mod pcm;
#[cfg(feature = "sherpa")]
pub mod sherpa_runner;
pub mod synth;

// Submodule re-exports for advanced/qualified-path access.
pub use bundle::{audio, error, io, library, manifest, text};

// Flat type re-exports — the primary public API.
pub use bundle::audio::{AudioCodec, AudioSegment};
pub use bundle::error::BundleError;
pub use bundle::io::{
    read_audio_segment, read_book_bundle, read_book_metadata, validate_audio_key,
    write_book_bundle, BundleWriter,
};
pub use bundle::library::{
    read_library_bundle, write_library_bundle, LibraryBundle, LibraryEntry, LibraryKind,
    LibraryManifest,
};
pub use bundle::manifest::{
    AudioMeta, BookMeta, Generator, Manifest, ManifestKind, SCHEMA_VERSION,
};
pub use bundle::text::ChapterText;
pub use bundle::BookBundle;

pub use cache_key::{cache_key, NORM_VERSION};
pub use encode::{Encoder, OpusEncoder, WavPassthrough};
pub use normalize::{normalize_for_speech, split_for_speech, MAX_SYNTH_CHARS};
pub use synth::{
    synthesize_paragraph, PiperRunner, SubprocessPiperRunner, SynthError, SynthOptions, SynthOutput,
};

#[cfg(feature = "native-encode")]
pub use merge::merge_bundle_audio;
#[cfg(feature = "native-encode")]
pub use opus_native::NativeOpusEncoder;
#[cfg(feature = "sherpa")]
pub use sherpa_runner::{default_espeak_data_dir, SherpaRunner};
