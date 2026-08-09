//! Desktop-only bundle I/O glue: output-path naming, the buffered file write,
//! and thin desktop-flavored wrappers around the worker's stamping core.
//!
//! The host-shared stamping core (parallel synth + manifest stamp + the
//! text-only input guard) lives in [`taletrek_worker::stamp`]. It is
//! **parameterized by `generator.app`** so the desktop and the personal server
//! stamp their distinct producer strings through one code path (see
//! [`taletrek_worker::stamp`] for the single-stamping-path invariant). The
//! wrappers here fix [`GENERATOR_APP`] = `"taletrek-desktop"` so [`main.rs`]'s
//! call sites are unchanged from the pre-extraction shape.
//!
//! [`main.rs`]: crate::main
//!
//! What stays desktop-only: [`default_synth_output`] / [`default_resynth_output`]
//! (CLI output-path naming — the server has no concept of "beside the input"),
//! and [`write_book_bundle_file`] (buffered file write — the server writes its
//! own store).

use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use thiserror::Error;

use taletrek_synth::synth::PiperRunner;
use taletrek_synth::{write_book_bundle, BookBundle, BundleError, Encoder};

use taletrek_worker::stamp;
use taletrek_worker::ProgressSink;

/// `generator.app` value stamped into every desktop-written bundle. Matches
/// `docs/bundle-format.md`'s enumeration of bundle producers. Passed to the
/// worker's stamping core by every desktop wrapper below so the desktop never
/// forgets to stamp it.
pub const GENERATOR_APP: &str = "taletrek-desktop";

// Re-export the host-shared stamping error types so desktop callers and tests
// can name them through `crate::bundle_io::` (as they did before the move),
// and so the wrapper signatures below can reference them unqualified.
pub use stamp::{FullInputError, StampError};

/// All the ways desktop bundle I/O can fail. Typed so callers can branch and
/// so `?` lifts cleanly into `anyhow` at the CLI boundary.
///
/// Only the file-write path is desktop-specific: the synth + stamp failures
/// surface through [`StampError`] (returned by the thin wrappers below). This
/// enum carries the serialization error from [`write_book_bundle`] plus the
/// buffered-file-write error.
#[derive(Debug, Error)]
pub enum BundleIoError {
    /// Serializing the bundle (ZIP + JSON) failed. Lifted from the lib.
    #[error(transparent)]
    Bundle(#[from] BundleError),

    /// Writing the output file failed (disk full, permissions, missing parent).
    /// Carries the output path so the user knows where it broke.
    #[error("writing output bundle to {path}: {source}")]
    WriteFile {
        /// The output path we tried to write.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },
}

/// Default output path for `synth`: `<input-stem>.synth.taletrek` beside the
/// input. `<stem>` is the input filename with its final extension removed.
///
/// `dir/book.taletrek` → `dir/book.synth.taletrek`. A bare `book.taletrek`
/// stays in the current directory. A path with no extension keeps its whole
/// name as the stem (e.g. `book` → `book.synth.taletrek`).
#[must_use]
pub fn default_synth_output(input: &Path) -> PathBuf {
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("book");
    let parent = input.parent().unwrap_or_else(|| Path::new(""));
    parent.join(format!("{stem}.synth.taletrek"))
}

/// Default output path for `resynth`: `<input-stem>.<voice_id>.taletrek`
/// beside the input. Embedding the voice id in the name keeps multiple
/// re-voiced variants of the same source distinct on disk
/// (`book.en_US-ryan-medium.taletrek` vs `book.en_US-lessac-medium.taletrek`).
///
/// `<stem>` is the input filename with its final extension removed. A bare
/// `book.taletrek` with voice `en_US-ryan-medium` stays in the current
/// directory as `book.en_US-ryan-medium.taletrek`. A path with no extension
/// keeps its whole name as the stem.
#[must_use]
pub fn default_resynth_output(input: &Path, voice_id: &str) -> PathBuf {
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("book");
    let parent = input.parent().unwrap_or_else(|| Path::new(""));
    parent.join(format!("{stem}.{voice_id}.taletrek"))
}

/// Refuse an already-full bundle for `synth`. Thin desktop wrapper around
/// [`taletrek_worker::stamp::refuse_full_input`], passing the input path's
/// display string as the caller-supplied label so the error message stays
/// useful. See the worker's module doc for the guard's semantics.
pub fn refuse_full_input(bundle: &BookBundle, input: &Path) -> Result<(), FullInputError> {
    stamp::refuse_full_input(bundle, &input.display().to_string())
}

/// Run the parallel synth engine over every paragraph in `bundle`, fill its
/// `audio` map, and stamp the manifest as a full bundle. Thin desktop wrapper
/// around [`taletrek_worker::stamp::synth_and_stamp`] that fixes
/// [`GENERATOR_APP`] — see the worker for the pure semantics. No file I/O.
pub fn synth_and_stamp<R, E, F>(
    bundle: &mut BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    progress: Option<&dyn ProgressSink>,
) -> Result<(), StampError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    stamp::synth_and_stamp(
        bundle,
        voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        GENERATOR_APP,
        progress,
    )
}

/// Re-voice a bundle: rewrite `book.voiceId` to `new_voice_id`, then re-synth
/// every paragraph under the new voice. Thin desktop wrapper around
/// [`taletrek_worker::stamp::resynth_and_stamp`] that fixes [`GENERATOR_APP`].
/// Accepts text-only or full input. See the worker for the pure semantics.
pub fn resynth_and_stamp<R, E, F>(
    bundle: &mut BookBundle,
    new_voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    progress: Option<&dyn ProgressSink>,
) -> Result<(), StampError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    stamp::resynth_and_stamp(
        bundle,
        new_voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        GENERATOR_APP,
        progress,
    )
}

/// Write `bundle` to `output` as a `.taletrek` ZIP file. Wraps the lib's
/// in-memory [`write_book_bundle`] with a buffered file write so callers don't
/// manage the `Write + Seek` handle themselves. The parent directory must
/// exist; this only creates the file.
pub fn write_book_bundle_file(bundle: &BookBundle, output: &Path) -> Result<(), BundleIoError> {
    let file = fs::File::create(output).map_err(|source| BundleIoError::WriteFile {
        path: output.to_path_buf(),
        source,
    })?;
    // BufWriter amortizes the single big `write_all` the lib issues after
    // `zip.finish()`; flush happens on drop.
    write_book_bundle(bundle, &mut BufWriter::new(file))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use taletrek_synth::synth::{PiperRunner, SynthError};
    use std::collections::HashMap;

    use taletrek_synth::{
        read_book_bundle, AudioCodec, AudioMeta, BookMeta, ChapterText, Generator, Manifest,
        ManifestKind, WavPassthrough, NORM_VERSION,
    };

    /// Canonical mono 16-bit 16 kHz WAV with `pcm` as its data payload — the
    /// shape Piper emits on stdout. Duplicated so the desktop residue tests
    /// stay self-contained (the stamping core's tests live in the worker now).
    fn canonical_wav(pcm: &[u8]) -> Vec<u8> {
        let data_len = u32::try_from(pcm.len()).unwrap();
        let mut out = Vec::with_capacity(44 + pcm.len());
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&16_000u32.to_le_bytes());
        out.extend_from_slice(&32_000u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.extend_from_slice(pcm);
        out
    }

    /// In-process runner: returns a fixed canonical WAV regardless of input.
    struct StubRunner;

    impl PiperRunner for StubRunner {
        fn predict(&mut self, _voice_model: &Path, _text: &str) -> Result<Vec<u8>, SynthError> {
            Ok(canonical_wav(&[0x01, 0x02, 0x03, 0x04]))
        }
    }

    /// Build a minimal bundle with the given audio-present flag + voice id.
    fn bundle(voice_id: &str, present: bool, chapters: Vec<ChapterText>) -> BookBundle {
        let chapter_count = u32::try_from(chapters.len()).unwrap();
        BookBundle {
            manifest: Manifest {
                schema_version: 1,
                kind: ManifestKind::Book,
                book: BookMeta {
                    id: "bk_test".into(),
                    title: "Test Book".into(),
                    author: None,
                    source_format: "txt".into(),
                    chapter_count,
                    voice_id: voice_id.into(),
                    created_at: 0,
                    updated_at: 0,
                    progress_fraction: None,
                },
                audio: AudioMeta {
                    present,
                    codec: AudioCodec::Opus,
                    norm_version: NORM_VERSION.parse().unwrap(),
                    segment_count: if present { u32::MAX } else { 0 },
                },
                generator: Generator {
                    app: "taletrek-spa".into(),
                    version: "0.0.0".into(),
                },
            },
            chapters,
            audio: HashMap::new(),
        }
    }

    fn text_only_bundle(voice_id: &str, chapters: Vec<ChapterText>) -> BookBundle {
        bundle(voice_id, false, chapters)
    }

    // ---- default_synth_output ----

    #[test]
    fn default_synth_output_adds_synth_suffix_beside_input() {
        let out = default_synth_output(Path::new("dir/book.taletrek"));
        assert_eq!(out, PathBuf::from("dir/book.synth.taletrek"));
    }

    #[test]
    fn default_synth_output_bare_filename_no_parent() {
        let out = default_synth_output(Path::new("book.taletrek"));
        assert_eq!(out, PathBuf::from("book.synth.taletrek"));
    }

    #[test]
    fn default_synth_output_no_extension_uses_whole_name_as_stem() {
        let out = default_synth_output(Path::new("book"));
        assert_eq!(out, PathBuf::from("book.synth.taletrek"));
    }

    // ---- default_resynth_output ----

    #[test]
    fn default_resynth_output_embeds_voice_beside_input() {
        let out = default_resynth_output(Path::new("dir/book.taletrek"), "en_US-ryan-medium");
        assert_eq!(out, PathBuf::from("dir/book.en_US-ryan-medium.taletrek"));
    }

    #[test]
    fn default_resynth_output_bare_filename_no_parent() {
        let out = default_resynth_output(Path::new("book.taletrek"), "en_US-hfc_female-medium");
        assert_eq!(out, PathBuf::from("book.en_US-hfc_female-medium.taletrek"));
    }

    #[test]
    fn default_resynth_output_no_extension_uses_whole_name_as_stem() {
        let out = default_resynth_output(Path::new("book"), "en_US-lessac-medium");
        assert_eq!(out, PathBuf::from("book.en_US-lessac-medium.taletrek"));
    }

    // ---- write_book_bundle_file ----

    #[test]
    fn write_book_bundle_file_round_trips_through_read_book_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("book.synth.taletrek");

        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new("bk_test", 0, "Ch", vec!["One.".into()])],
        );
        // Use the desktop wrapper so the manifest it stamps reads
        // generator.app == "taletrek-desktop" — the invariant main.rs relies on.
        synth_and_stamp(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
        )
        .expect("synth succeeds");

        write_book_bundle_file(&b, &out).expect("file write should succeed");
        assert!(out.is_file(), "output file must exist");

        let bytes = std::fs::read(&out).unwrap();
        let back = read_book_bundle(&bytes).expect("round-trip read should succeed");
        assert!(back.manifest.audio.present);
        assert_eq!(back.manifest.audio.segment_count, 1);
        // The desktop wrapper stamps its own producer string.
        assert_eq!(back.manifest.generator.app, GENERATOR_APP);
    }

    #[test]
    fn write_book_bundle_file_surfaces_io_error_for_missing_parent() {
        let b = text_only_bundle("v", vec![]);
        // /no/such/dir/ — the parent doesn't exist, so File::create fails.
        let out = Path::new("/no/such/dir/out.taletrek");
        let err = write_book_bundle_file(&b, out).expect_err("missing parent must error");
        match err {
            BundleIoError::WriteFile { path, source: _ } => assert_eq!(path, out),
            other => panic!("expected WriteFile, got {other:?}"),
        }
    }

    // ---- desktop wrappers stamp the desktop producer string ----

    #[test]
    fn synth_and_stamp_wrapper_stamps_desktop_generator_app() {
        // The thin wrapper fixes generator.app = GENERATOR_APP; this pins that
        // the desktop can't drift from "taletrek-desktop" via the worker path.
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new("bk_test", 0, "Ch", vec!["Hi.".into()])],
        );
        synth_and_stamp(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
        )
        .expect("wrapper succeeds");

        assert_eq!(b.manifest.generator.app, GENERATOR_APP);
        assert_eq!(b.manifest.generator.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn refuse_full_input_wrapper_labels_with_input_path_display() {
        // The desktop wrapper passes the input path's display string as the
        // label, so the error identifies the file (not a book id).
        let b = bundle("en_US-lessac-medium", true, vec![]);

        let err = refuse_full_input(&b, Path::new("dir/full.taletrek")).unwrap_err();
        assert_eq!(err.input, "dir/full.taletrek");
        assert_eq!(err.voice, "en_US-lessac-medium");
    }
}
