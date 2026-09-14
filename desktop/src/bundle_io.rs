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
//!
//! # Two write paths, deliberately
//!
//! `synth` **streams**: [`synth_stamp_to_file`] opens a same-dir temp before
//! synthesis and hands every finished segment to the worker's streaming stamp
//! ([`taletrek_worker::stamp::synth_and_stamp_streaming`]) — peak memory is
//! one segment, not the whole book's audio (the `streaming-synth` bound; the
//! GUI executor and the CLI `synth` both route here). `parse` and `resynth`
//! keep the in-memory [`write_book_bundle_file`]: parse output is text-only
//! (tiny), and re-voicing is spec-deferred to a follow-up (desktop RAM
//! headroom makes it non-urgent). Atomic-write discipline is shared: both
//! paths write a unique same-dir temp and rename only a complete archive —
//! never a partial book.

use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use thiserror::Error;

use taletrek_synth::synth::PiperRunner;
use taletrek_synth::{
    write_book_bundle, BookBundle, BundleError, BundleWriter, Encoder, Generator,
};

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

    /// Synthesis or stamping failed inside the streaming write path. Lifted
    /// from the worker's stamping core — carried here because
    /// [`synth_stamp_to_file`] runs synth, stamp, and file write as one
    /// atomic operation.
    #[error(transparent)]
    Stamp(#[from] StampError),

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

/// Default output path for `parse`: `<input-stem>.taletrek` beside the input.
/// The source extension is swapped for `.taletrek` — `dir/book.epub` →
/// `dir/book.taletrek`. A bare `book.txt` stays in the current directory; a
/// path with no extension keeps its whole name as the stem
/// (`book` → `book.taletrek`).
#[must_use]
pub fn default_parse_output(input: &Path) -> PathBuf {
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("book");
    let parent = input.parent().unwrap_or_else(|| Path::new(""));
    parent.join(format!("{stem}.taletrek"))
}

/// The `generator` identity every desktop-produced bundle is born with.
/// `parse` stamps it at bundle-build time ([`to_text_only_bundle`]);
/// `synth`/`resynth` re-stamp the same identity through the worker's
/// parameterized seam when they fill the audio.
///
/// [`to_text_only_bundle`]: taletrek_parse::to_text_only_bundle
#[must_use]
pub fn desktop_generator() -> Generator {
    Generator {
        app: GENERATOR_APP.into(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

/// Refuse an already-full bundle for `synth`. Thin desktop wrapper around
/// [`taletrek_worker::stamp::refuse_full_input`], passing the input path's
/// display string as the caller-supplied label so the error message stays
/// useful. See the worker's module doc for the guard's semantics.
pub fn refuse_full_input(bundle: &BookBundle, input: &Path) -> Result<(), FullInputError> {
    stamp::refuse_full_input(bundle, &input.display().to_string())
}

/// Unique same-dir temp path for `path`: `<name>.<pid>.<seq>.tmp`. Mirrors
/// the kernel pipeline's helper — the temp MUST live in the destination
/// directory (rename across filesystems fails with `EXDEV`), and the
/// pid+seq suffix keeps concurrent writers from clobbering each other's
/// temp.
fn unique_tmp_path(path: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
    ))
}

/// The desktop's `synth` write path: stream every synthesized segment of
/// `bundle` into a same-dir temp beside `output`, stamp the manifest through
/// the single stamping path (fixing [`GENERATOR_APP`]), and rename the
/// complete archive into `output`. Returns the dedup'd segment count for the
/// caller's summary (`bundle.audio` is never populated — nothing
/// accumulates; see the module doc's two-write-paths note).
///
/// The temp is opened **before** synthesis begins; on any failure (synth,
/// stamp, write) it is removed — never a partial book. The parent directory
/// must exist (callers create the output dir; the CLI writes beside the
/// input).
#[allow(clippy::too_many_arguments)] // mirrors the stamping core's seam set; the wrapper adds only `output`.
pub fn synth_stamp_to_file<R, E, F>(
    bundle: &mut BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
    progress: Option<&dyn ProgressSink>,
    output: &Path,
) -> Result<u32, BundleIoError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    let tmp = unique_tmp_path(output);
    let discard_tmp = |e: BundleIoError| {
        let _ = fs::remove_file(&tmp);
        e
    };

    let file = fs::File::create(&tmp).map_err(|source| BundleIoError::WriteFile {
        path: output.to_path_buf(),
        source,
    })?;
    let writer = BundleWriter::new(BufWriter::new(file), &bundle.chapters)
        .map_err(|e| discard_tmp(e.into()))?;

    let (_sink, segment_count) = stamp::synth_and_stamp_streaming(
        bundle,
        voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
        GENERATOR_APP,
        progress,
        writer,
    )
    .map_err(|e| discard_tmp(e.into()))?;
    fs::rename(&tmp, output).map_err(|source| {
        discard_tmp(BundleIoError::WriteFile {
            path: output.to_path_buf(),
            source,
        })
    })?;
    Ok(segment_count)
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

    use std::collections::HashMap;
    use taletrek_synth::synth::{PiperRunner, SynthError};

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

    // ---- default_parse_output ----

    #[test]
    fn default_parse_output_swaps_extension_to_taletrek_beside_input() {
        let out = default_parse_output(Path::new("dir/book.epub"));
        assert_eq!(out, PathBuf::from("dir/book.taletrek"));
    }

    #[test]
    fn default_parse_output_bare_filename_no_parent() {
        let out = default_parse_output(Path::new("plain.txt"));
        assert_eq!(out, PathBuf::from("plain.taletrek"));
    }

    #[test]
    fn default_parse_output_no_extension_uses_whole_name_as_stem() {
        let out = default_parse_output(Path::new("book"));
        assert_eq!(out, PathBuf::from("book.taletrek"));
    }

    // ---- desktop_generator ----

    #[test]
    fn desktop_generator_carries_app_and_version() {
        let generator = desktop_generator();
        assert_eq!(generator.app, GENERATOR_APP);
        assert_eq!(generator.version, env!("CARGO_PKG_VERSION"));
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
        // Produce the full bundle through the streaming path so the manifest
        // it stamps reads generator.app == "taletrek-desktop" — the invariant
        // main.rs relies on — then exercise the buffered file write on it.
        synth_stamp_to_file(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
            &out,
        )
        .expect("streaming stamp succeeds");

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

    // ---- synth_stamp_to_file (streaming synth write path — streaming-synth) ----

    #[test]
    fn synth_stamp_to_file_streams_stamps_and_renames() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("book.synth.taletrek");
        let mut b = text_only_bundle(
            "v-old",
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["Hello world.".into(), "Second.".into()],
            )],
        );

        let count = synth_stamp_to_file(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
            &out,
        )
        .expect("streaming stamp succeeds");

        assert_eq!(count, 2, "dedup'd segment count returns to the caller");
        // Nothing accumulated in memory — the bundle's audio map stays empty.
        assert!(b.audio.is_empty());
        assert!(b.manifest.audio.present, "manifest stamped in place");
        assert_eq!(b.manifest.book.voice_id, "v", "voice rewrite contract");

        // Same-dir temp is renamed into place; no residue.
        assert!(out.is_file(), "output exists");
        let residue: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(residue.is_empty(), "temp residue: {residue:?}");

        let back = read_book_bundle(&std::fs::read(&out).unwrap()).unwrap();
        assert!(back.manifest.audio.present);
        assert_eq!(back.manifest.audio.segment_count, 2);
        assert_eq!(back.manifest.generator.app, GENERATOR_APP);
        assert_eq!(back.manifest.generator.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(back.audio.len(), 2);
    }

    #[test]
    fn synth_stamp_to_file_failure_removes_temp_and_writes_nothing() {
        // A whitespace-only paragraph aborts synthesis (EmptyText) AFTER the
        // temp file exists — the failure must leave neither output nor temp.
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("book.synth.taletrek");
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["   \n   ".into()],
            )],
        );

        let err = synth_stamp_to_file(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
            &out,
        )
        .expect_err("empty paragraph must abort");
        assert!(
            matches!(err, BundleIoError::Stamp(_)),
            "expected Stamp, got {err:?}"
        );

        assert!(!out.exists(), "no output on failure");
        let residue: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(residue.is_empty(), "temp residue: {residue:?}");
    }

    // ---- desktop wrappers stamp the desktop producer string ----

    #[test]
    fn synth_stamp_to_file_stamps_desktop_generator_app() {
        // The streaming wrapper fixes generator.app = GENERATOR_APP; this
        // pins that the desktop can't drift from "taletrek-desktop" via the
        // worker path.
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("book.synth.taletrek");
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new("bk_test", 0, "Ch", vec!["Hi.".into()])],
        );
        synth_stamp_to_file(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
            None,
            &out,
        )
        .expect("wrapper succeeds");

        assert_eq!(b.manifest.generator.app, GENERATOR_APP);
        assert_eq!(b.manifest.generator.version, env!("CARGO_PKG_VERSION"));
        let back = read_book_bundle(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!(back.manifest.generator.app, GENERATOR_APP);
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
