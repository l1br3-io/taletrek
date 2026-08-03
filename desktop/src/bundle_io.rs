//! Bundle I/O glue: turn a synth'd bundle into a stamped `.taletrek` file on disk.
//!
//! [`synth_and_stamp`] runs the parallel synth engine (Phase 3) over a bundle,
//! fills its `audio` map, and stamps the manifest as a full bundle. It is pure:
//! no file I/O, no network — those live in `run_synth`/`run_resynth`. The
//! manifest's `book.voice_id` is preserved here; `resynth` (Phase 5) rewrites it
//! before calling in so the cache keys and manifest agree after a voice swap.
//!
//! [`write_book_bundle_file`] wraps the lib's in-memory writer with a buffered
//! file write; [`default_synth_output`] computes the `<input-stem>.synth.taletrek`
//! default so `synth` and its test share one source of truth, and
//! [`refuse_full_input`] guards `synth` against already-full input.

use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use thiserror::Error;

use taletrek_synth::bundle::manifest::{AudioMeta, Generator};
use taletrek_synth::synth::PiperRunner;
use taletrek_synth::{
    write_book_bundle, AudioCodec, BookBundle, BundleError, Encoder, NORM_VERSION,
};

use crate::synth_job::{synth_all_paragraphs, SynthJobError};

/// `generator.app` value stamped into every desktop-written bundle. Matches
/// `docs/bundle-format.md`'s enumeration of bundle producers.
pub const GENERATOR_APP: &str = "taletrek-desktop";

/// Error returned when `synth` is pointed at a bundle that already carries
/// audio. `synth` only accepts text-only input; the user wants `resynth` to
/// re-voice an existing bundle. Carries the existing `voiceId` so the message
/// can hint at what's already there.
#[derive(Debug, Error)]
#[error(
    "input bundle `{input}` already contains audio (voice `{voice}`); use `taletrek-desktop resynth` to re-voice it"
)]
pub struct FullInputError {
    /// Display string of the input path.
    pub input: String,
    /// The voice the existing audio was synth'd under (`book.voiceId`).
    pub voice: String,
}

/// All the ways desktop bundle I/O can fail. Typed so callers can branch and
/// so `?` lifts cleanly into `anyhow` at the CLI boundary.
#[derive(Debug, Error)]
pub enum BundleIoError {
    /// Parallel synth failed (first-paragraph abort, pool build, etc.). Lifted
    /// from [`SynthJobError`].
    #[error(transparent)]
    Synth(#[from] SynthJobError),

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

/// Refuse an already-full bundle for `synth`. `synth` only accepts text-only
/// input (`audio.present == false`); re-voicing an existing bundle is what
/// `resynth` is for. The error carries the input path display + the existing
/// `book.voiceId` so the message can point the user at `resynth`.
pub fn refuse_full_input(bundle: &BookBundle, input: &Path) -> Result<(), FullInputError> {
    if bundle.manifest.audio.present {
        return Err(FullInputError {
            input: input.display().to_string(),
            voice: bundle.manifest.book.voice_id.clone(),
        });
    }
    Ok(())
}

/// Stamp `bundle`'s manifest to reflect a completed synth run: audio present,
/// the encoder's codec, the current norm version, the segment count, and the
/// `taletrek-desktop` generator at the running crate version. The book's
/// `voice_id` is preserved — `synth` keeps the input value; `resynth` rewrites
/// it before calling [`synth_and_stamp`] so keys and manifest agree.
fn stamp_full_manifest(bundle: &mut BookBundle, codec: AudioCodec) {
    // Dedup collapses identical paragraphs into one segment, so `segment_count`
    // is the stored entry count (not the paragraph count). Matches how the SPA's
    // audio cache behaves and what `read_book_bundle` reconstructs on import.
    let segment_count = u32::try_from(bundle.audio.len()).unwrap_or(u32::MAX);
    bundle.manifest.audio = AudioMeta {
        present: true,
        codec,
        norm_version: NORM_VERSION
            .parse()
            .expect("NORM_VERSION is a decimal u32 (crate invariant)"),
        segment_count,
    };
    bundle.manifest.generator = Generator {
        app: GENERATOR_APP.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
}

/// Run the parallel synth engine over every paragraph in `bundle`, fill its
/// `audio` map with the resulting segments, and stamp the manifest as a full
/// bundle. Pure: no file I/O, no network.
///
/// `voice_id` namespaces the cache keys; the caller ensures it matches the
/// manifest's `book.voice_id` when that matters (for `resynth`, rewrite
/// `book.voice_id` first). `make_runner` is called once per paragraph to
/// produce a fresh, task-owned runner (see [`synth_all_paragraphs`]). The
/// encoder is shared by `&E` across all tasks.
///
/// Aborts on the first paragraph error (lifted as [`BundleIoError::Synth`]).
pub fn synth_and_stamp<R, E, F>(
    bundle: &mut BookBundle,
    voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
) -> Result<(), BundleIoError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    let segments = synth_all_paragraphs(bundle, voice_id, voice_model, make_runner, encoder, jobs)?;
    // Replace (don't extend) so resynth's stale audio under the old voice is
    // discarded — synth starts from an empty audio map.
    bundle.audio = segments;
    stamp_full_manifest(bundle, encoder.codec());
    Ok(())
}

/// Re-voice a bundle: rewrite `book.voiceId` to `new_voice_id`, then re-synth
/// every paragraph under the new voice. The audio map is **replaced**
/// (delegates to [`synth_and_stamp`]), so stale segments keyed under the
/// previous voice are discarded — not merged.
///
/// Unlike `synth`, this accepts **both** text-only and full input: re-voicing
/// a full bundle is the whole point. The caller must not run [`refuse_full_input`].
///
/// Aborts on the first paragraph error (lifted as [`BundleIoError::Synth`]),
/// matching `synth`'s v1 semantics.
pub fn resynth_and_stamp<R, E, F>(
    bundle: &mut BookBundle,
    new_voice_id: &str,
    voice_model: &Path,
    make_runner: F,
    encoder: &E,
    jobs: usize,
) -> Result<(), BundleIoError>
where
    R: PiperRunner + Send,
    E: Encoder + Sync,
    F: Fn() -> R + Sync,
{
    // Rewrite the manifest's voice FIRST so the stamped manifest and the
    // content-addressed cache keys agree on the new voice. stamp_full_manifest
    // preserves this value (it only touches audio.* + generator.*).
    bundle.manifest.book.voice_id = new_voice_id.to_string();
    synth_and_stamp(
        bundle,
        new_voice_id,
        voice_model,
        make_runner,
        encoder,
        jobs,
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
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::path::Path;

    use taletrek_synth::synth::{PiperRunner, SynthError};
    use taletrek_synth::{
        cache_key, read_book_bundle, AudioCodec, AudioMeta, AudioSegment, BookBundle, BookMeta,
        ChapterText, Generator, Manifest, ManifestKind, WavPassthrough,
    };

    /// Canonical mono 16-bit 16 kHz WAV with `pcm` as its data payload — the
    /// shape Piper emits on stdout. Duplicated from `synth_job.rs` so each
    /// module's tests stay self-contained.
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
    /// Defaults to a text-only bundle under the given voice.
    fn bundle(voice_id: &str, present: bool, chapters: Vec<ChapterText>) -> BookBundle {
        let chapter_count = u32::try_from(chapters.len()).unwrap();
        let segment_count = if present { u32::MAX } else { 0 };
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
                    segment_count,
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

    // ---- refuse_full_input ----

    #[test]
    fn refuse_full_input_accepts_text_only() {
        let b = text_only_bundle("v", vec![]);
        assert!(refuse_full_input(&b, Path::new("x.taletrek")).is_ok());
    }

    #[test]
    fn refuse_full_input_rejects_full_bundle_with_existing_voice() {
        let b = bundle("en_US-lessac-medium", true, vec![]);
        let err = refuse_full_input(&b, Path::new("full.taletrek")).unwrap_err();
        assert_eq!(err.input, "full.taletrek");
        assert_eq!(err.voice, "en_US-lessac-medium");
        assert!(
            err.to_string().contains("resynth"),
            "error must point at resynth: {err}"
        );
    }

    // ---- synth_and_stamp + stamp_full_manifest ----

    #[test]
    fn synth_and_stamp_round_trips_with_correct_manifest() {
        let mut b = text_only_bundle(
            "en_US-hfc_female-medium",
            vec![
                ChapterText::new(
                    "bk_test",
                    0,
                    "Ch",
                    vec!["Hello world.".into(), "Second paragraph.".into()],
                ),
                ChapterText::new("bk_test", 1, "Two", vec!["Across chapters.".into()]),
            ],
        );
        let voice = "en_US-hfc_female-medium";

        synth_and_stamp(
            &mut b,
            voice,
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
        )
        .expect("synth + stamp should succeed with stub runner");

        // Round-trip through the lib's writer/reader so the manifest we stamp
        // is exactly what a consumer will see on import.
        let mut buf = Cursor::new(Vec::new());
        write_book_bundle(&b, &mut buf).expect("write should succeed");
        let back = read_book_bundle(&buf.into_inner()).expect("read should succeed");

        // Audio descriptor flipped to "full" with the encoder's codec (WAV via
        // WavPassthrough), current norm version, and the dedup'd segment count.
        assert!(back.manifest.audio.present, "audio.present must be true");
        assert_eq!(back.manifest.audio.codec, AudioCodec::Wav);
        assert_eq!(
            back.manifest.audio.norm_version,
            NORM_VERSION.parse::<u32>().unwrap()
        );
        assert_eq!(back.manifest.audio.segment_count, 3);

        // Generator stamped as taletrek-desktop at the running crate version.
        assert_eq!(back.manifest.generator.app, GENERATOR_APP);
        assert_eq!(back.manifest.generator.version, env!("CARGO_PKG_VERSION"));

        // book.voiceId preserved (synth does not rewrite it).
        assert_eq!(back.manifest.book.voice_id, voice);

        // Every distinct paragraph produced a segment keyed by cache_key, and
        // the audio map survived the round-trip intact.
        let expected_keys = [
            cache_key(voice, "Hello world."),
            cache_key(voice, "Second paragraph."),
            cache_key(voice, "Across chapters."),
        ];
        for k in &expected_keys {
            assert!(back.audio.contains_key(k), "missing audio for {k}");
        }
        assert_eq!(back.audio.len(), expected_keys.len());
    }

    #[test]
    fn synth_and_stamp_preserves_book_voice_id_when_synth_voice_differs() {
        // synth uses --voice for keying but must NOT rewrite book.voiceId
        // (that's resynth's job). A mismatch is the user's choice; we keep the
        // manifest's value verbatim.
        let mut b = text_only_bundle(
            "en_US-lessac-medium",
            vec![ChapterText::new("bk_test", 0, "Ch", vec!["Hi.".into()])],
        );

        synth_and_stamp(
            &mut b,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
        )
        .expect("stub runner succeeds");

        assert_eq!(
            b.manifest.book.voice_id, "en_US-lessac-medium",
            "synth must keep the input book.voiceId"
        );
        // Audio is keyed under the synth voice (ryan), not the manifest voice.
        assert!(b.audio.contains_key(&cache_key("en_US-ryan-medium", "Hi.")));
    }

    #[test]
    fn synth_and_stamp_segment_count_reflects_dedup() {
        // Two identical paragraphs collapse to one segment (content addressing);
        // segmentCount must be 1, not 2.
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["Repeat.".into(), "Repeat.".into()],
            )],
        );

        synth_and_stamp(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
        )
        .expect("stub runner succeeds");

        assert_eq!(b.manifest.audio.segment_count, 1);
        assert_eq!(b.audio.len(), 1);
    }

    #[test]
    fn synth_and_stamp_aborts_on_empty_paragraph() {
        // Delegates to synth_job's abort-on-first-error: an empty paragraph
        // surfaces as Synth(EmptyText), not a silent skip.
        let mut b = text_only_bundle(
            "v",
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["   \n   ".into()],
            )],
        );

        let err = synth_and_stamp(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
        )
        .expect_err("empty paragraph must error");
        assert!(matches!(err, BundleIoError::Synth(_)));
    }

    // ---- resynth_and_stamp ----

    #[test]
    fn resynth_and_stamp_updates_manifest_voice_and_rekeys_segments() {
        // Start from a full bundle under voice A; resynth to voice B; assert
        // the manifest's voiceId flipped to B and every segment is keyed under B.
        let mut b = bundle(
            "en_US-lessac-medium",
            true,
            vec![
                ChapterText::new(
                    "bk_test",
                    0,
                    "Ch",
                    vec!["Hello world.".into(), "Second.".into()],
                ),
                ChapterText::new("bk_test", 1, "Two", vec!["Across chapters.".into()]),
            ],
        );

        resynth_and_stamp(
            &mut b,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            2,
        )
        .expect("resynth should succeed with stub runner");

        // Manifest voice flipped to the new voice.
        assert_eq!(b.manifest.book.voice_id, "en_US-ryan-medium");
        // Audio marked present + segment count matches distinct paragraphs.
        assert!(b.manifest.audio.present);
        assert_eq!(b.manifest.audio.segment_count, 3);

        // Every segment keyed under the new voice.
        let new_voice = "en_US-ryan-medium";
        for text in &["Hello world.", "Second.", "Across chapters."] {
            let key = cache_key(new_voice, text);
            assert!(
                b.audio.contains_key(&key),
                "missing segment keyed under new voice: {key}"
            );
        }
        // No segments keyed under the old voice survive.
        let old_voice = "en_US-lessac-medium";
        for text in &["Hello world.", "Second.", "Across chapters."] {
            let key = cache_key(old_voice, text);
            assert!(
                !b.audio.contains_key(&key),
                "stale segment under old voice survived: {key}"
            );
        }
    }

    #[test]
    fn resynth_and_stamp_discards_stale_audio_from_previous_voice() {
        // A full bundle carrying audio under the OLD voice. After resynth, none
        // of those old segments survive — synth_and_stamp replaces (not
        // extends) the audio map.
        let mut b = bundle(
            "en_US-lessac-medium",
            true,
            vec![ChapterText::new(
                "bk_test",
                0,
                "Ch",
                vec!["Hello world.".into()],
            )],
        );
        // Pre-populate audio under the old voice (as a prior synth run would).
        let old_key = cache_key("en_US-lessac-medium", "Hello world.");
        b.audio.insert(
            old_key.clone(),
            AudioSegment {
                key: old_key.clone(),
                codec: AudioCodec::Wav,
                bytes: canonical_wav(&[0xFF]),
            },
        );
        assert_eq!(
            b.audio.len(),
            1,
            "fixture: one stale segment under old voice"
        );

        resynth_and_stamp(
            &mut b,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
        )
        .expect("resynth succeeds");

        // The old segment is gone; only the new-voice segment remains.
        assert!(
            !b.audio.contains_key(&old_key),
            "old-voice segment must be discarded"
        );
        let new_key = cache_key("en_US-ryan-medium", "Hello world.");
        assert!(
            b.audio.contains_key(&new_key),
            "new-voice segment must be present"
        );
        assert_eq!(b.audio.len(), 1);
    }

    #[test]
    fn resynth_and_stamp_accepts_text_only_input() {
        // resynth accepts text-only input too (it's "synth + voice rewrite").
        let mut b = text_only_bundle(
            "en_US-lessac-medium",
            vec![ChapterText::new("bk_test", 0, "Ch", vec!["Hi.".into()])],
        );

        resynth_and_stamp(
            &mut b,
            "en_US-ryan-medium",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
        )
        .expect("resynth on text-only should succeed");

        assert_eq!(b.manifest.book.voice_id, "en_US-ryan-medium");
        assert!(b.manifest.audio.present);
        assert!(b.audio.contains_key(&cache_key("en_US-ryan-medium", "Hi.")));
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
        synth_and_stamp(
            &mut b,
            "v",
            Path::new("/dev/null"),
            || StubRunner,
            &WavPassthrough,
            1,
        )
        .expect("synth succeeds");

        write_book_bundle_file(&b, &out).expect("file write should succeed");
        assert!(out.is_file(), "output file must exist");

        let bytes = std::fs::read(&out).unwrap();
        let back = read_book_bundle(&bytes).expect("round-trip read should succeed");
        assert!(back.manifest.audio.present);
        assert_eq!(back.manifest.audio.segment_count, 1);
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
}
