//! Book-bundle read/write (ZIP container). See `docs/bundle-format.md`.

use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use super::audio::{AudioCodec, AudioSegment};
use super::error::BundleError;
use super::manifest::{Manifest, SCHEMA_VERSION};
use super::text::TextFile;
use super::BookBundle;

const MANIFEST_ENTRY: &str = "manifest.json";
const TEXT_ENTRY: &str = "text.json";
const AUDIO_PREFIX: &str = "audio/";

/// Default cap on any single entry's decompressed size: 256 MiB. The largest
/// legitimate entry is a nested full-book bundle inside a `.taletrek-lib`
/// (mobile whole-book audio caps ~200 MB — G20), so this leaves headroom.
pub const DEFAULT_MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;

/// Default cap on the summed decompressed size of one archive's entries:
/// 1 GiB. A library of several full books fits comfortably; anything beyond
/// is either a mistake or hostile.
pub const DEFAULT_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

/// Decompression budget applied while reading an archive.
///
/// GOTCHA: a body-size limit on *uploads* bounds only the **compressed**
/// bytes; deflate amplifies ~1000×, and a `.taletrek-lib` nests archives
/// (zip-of-zips), so an unbounded `read_to_end` is a memory-exhaustion vector
/// for any reader fed bundles from elsewhere (the server's upload path). The
/// budget bounds the blast radius: reads are capped per entry and in total,
/// rejecting with [`BundleError::EntryTooLarge`] / [`BundleError::TotalTooLarge`].
///
/// Each `read_*` call gets a fresh budget — a library archive's budget bounds
/// its manifest + nested-book bytes, and each nested book parse is itself
/// budgeted, so the worst crafted nesting peaks around 2× the budget.
#[derive(Debug, Clone, Copy)]
pub struct ReadBudget {
    /// Cap on any single entry's decompressed size.
    pub max_entry_bytes: u64,
    /// Cap on the summed decompressed size of every entry in one archive.
    pub total_bytes: u64,
}

impl Default for ReadBudget {
    fn default() -> Self {
        Self {
            max_entry_bytes: DEFAULT_MAX_ENTRY_BYTES,
            total_bytes: DEFAULT_TOTAL_BYTES,
        }
    }
}

/// Serialize `bundle` to a `.taletrek` ZIP written into `out`.
pub fn write_book_bundle(
    bundle: &BookBundle,
    out: &mut (impl Write + std::io::Seek),
) -> Result<(), BundleError> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default();

    zip.start_file(MANIFEST_ENTRY, opts)?;
    zip.write_all(&serde_json::to_vec_pretty(&bundle.manifest)?)?;

    zip.start_file(TEXT_ENTRY, opts)?;
    let text = TextFile {
        schema_version: SCHEMA_VERSION,
        chapters: bundle.chapters.clone(),
    };
    zip.write_all(&serde_json::to_vec_pretty(&text)?)?;

    for (key, seg) in &bundle.audio {
        let name = format!("{AUDIO_PREFIX}{key}.{}", seg.codec.ext());
        zip.start_file(&name, opts)?;
        zip.write_all(&seg.bytes)?;
    }

    let bytes = zip.finish()?.into_inner();
    out.write_all(&bytes)?;
    Ok(())
}

/// Parse a `.taletrek` ZIP from `input` into a [`BookBundle`] under the
/// default [`ReadBudget`].
pub fn read_book_bundle(input: &[u8]) -> Result<BookBundle, BundleError> {
    read_book_bundle_with_budget(input, ReadBudget::default())
}

/// Parse a `.taletrek` ZIP under a caller-supplied [`ReadBudget`] (hosts with
/// their own upload-size config can mirror it here).
///
/// Accepts both text-only and full bundles. A `schemaVersion` this reader does
/// not understand yields [`BundleError::UnknownSchema`].
pub fn read_book_bundle_with_budget(
    input: &[u8],
    budget: ReadBudget,
) -> Result<BookBundle, BundleError> {
    let mut archive = ZipArchive::new(Cursor::new(input.to_vec()))?;
    let mut remaining = budget.total_bytes;

    let manifest: Manifest = read_json_entry(
        &mut archive,
        MANIFEST_ENTRY,
        "manifest.json",
        budget,
        &mut remaining,
    )?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(BundleError::UnknownSchema {
            found: manifest.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    let text: TextFile = read_json_entry(
        &mut archive,
        TEXT_ENTRY,
        "text.json",
        budget,
        &mut remaining,
    )?;

    // Audio segments are optional (text-only bundle). Scan only when the
    // manifest declares audio present.
    let mut audio = std::collections::HashMap::new();
    if manifest.audio.present {
        for i in 0..archive.len() {
            let mut f = archive.by_index(i)?;
            let name = f.name().to_string();
            let buf = read_capped(&mut f, &name, budget, &mut remaining)?;
            if let Some(rest) = name.strip_prefix(AUDIO_PREFIX) {
                if let Some((key, ext)) = rest.rsplit_once('.') {
                    if let Some(codec) = AudioCodec::from_ext(ext) {
                        audio.insert(
                            key.to_string(),
                            AudioSegment {
                                key: key.to_string(),
                                codec,
                                bytes: buf,
                            },
                        );
                    }
                }
            }
        }
    }

    Ok(BookBundle {
        manifest,
        chapters: text.chapters,
        audio,
    })
}

/// Serialize a book bundle to an in-memory byte vector (used by the library
/// writer to nest book bundles inside a library archive).
pub(crate) fn book_bundle_to_bytes(bundle: &BookBundle) -> Result<Vec<u8>, BundleError> {
    let mut buf = Cursor::new(Vec::new());
    write_book_bundle(bundle, &mut buf)?;
    Ok(buf.into_inner())
}

/// Read + deserialize a JSON entry by name from the archive.
fn read_json_entry<T: serde::de::DeserializeOwned>(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    name: &str,
    missing: &'static str,
    budget: ReadBudget,
    remaining: &mut u64,
) -> Result<T, BundleError> {
    let mut f = archive
        .by_name(name)
        .map_err(|_| BundleError::MissingEntry(missing))?;
    let entry_name = f.name().to_string();
    let buf = read_capped(&mut f, &entry_name, budget, remaining)?;
    Ok(serde_json::from_slice(&buf)?)
}

/// Read one entry fully, enforcing the per-entry cap and the archive's running
/// total. The declared `size()` is checked first (cheap early rejection), but
/// the `take()` bound is what actually enforces — crafted metadata can lie.
pub(crate) fn read_capped(
    f: &mut zip::read::ZipFile<'_>,
    name: &str,
    budget: ReadBudget,
    remaining: &mut u64,
) -> Result<Vec<u8>, BundleError> {
    if f.size() > budget.max_entry_bytes {
        return Err(BundleError::EntryTooLarge {
            name: name.to_string(),
            limit: budget.max_entry_bytes,
        });
    }
    let mut limited = f.take(budget.max_entry_bytes.saturating_add(1));
    let mut buf = Vec::new();
    limited.read_to_end(&mut buf)?;
    let got = buf.len() as u64;
    if got > budget.max_entry_bytes {
        return Err(BundleError::EntryTooLarge {
            name: name.to_string(),
            limit: budget.max_entry_bytes,
        });
    }
    if got > *remaining {
        return Err(BundleError::TotalTooLarge {
            limit: budget.total_bytes,
        });
    }
    *remaining -= got;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::manifest::{AudioMeta, BookMeta, Generator, Manifest, ManifestKind};
    use crate::NORM_VERSION;

    /// A minimal valid manifest (audio absent), serialized as `manifest.json`.
    fn manifest_json() -> Vec<u8> {
        let manifest = Manifest {
            schema_version: SCHEMA_VERSION,
            kind: ManifestKind::Book,
            book: BookMeta {
                id: "bk_cap".into(),
                title: "Caps".into(),
                author: None,
                source_format: "txt".into(),
                chapter_count: 1,
                voice_id: "v".into(),
                created_at: 0,
                updated_at: 0,
                progress_fraction: None,
            },
            audio: AudioMeta {
                present: false,
                codec: AudioCodec::Opus,
                norm_version: NORM_VERSION.parse().unwrap(),
                segment_count: 0,
            },
            generator: Generator {
                app: "taletrek-test".into(),
                version: "0.0.0".into(),
            },
        };
        serde_json::to_vec(&manifest).unwrap()
    }

    /// Build an archive with a valid `manifest.json` + a `text.json` entry of
    /// `text_len` zero bytes (deflate collapses zeros, so the compressed
    /// archive stays tiny while the entry inflates to `text_len`).
    fn archive_with_inflated_text(text_len: usize) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(MANIFEST_ENTRY, opts).unwrap();
        zip.write_all(&manifest_json()).unwrap();
        zip.start_file(TEXT_ENTRY, opts).unwrap();
        zip.write_all(&vec![0u8; text_len]).unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn entry_over_the_per_entry_cap_is_rejected() {
        let bytes = archive_with_inflated_text(64 * 1024);
        let budget = ReadBudget {
            max_entry_bytes: 16 * 1024,
            total_bytes: 1024 * 1024,
        };
        let err = read_book_bundle_with_budget(&bytes, budget).unwrap_err();
        match err {
            BundleError::EntryTooLarge { name, limit } => {
                assert_eq!(name, TEXT_ENTRY);
                assert_eq!(limit, 16 * 1024);
            }
            other => panic!("expected EntryTooLarge, got {other:?}"),
        }
    }

    #[test]
    fn entries_over_the_total_budget_are_rejected() {
        // Each entry is under the per-entry cap, but the two together cross
        // the total budget — the second read must fail with TotalTooLarge.
        let bytes = archive_with_inflated_text(4 * 1024);
        let manifest_len = manifest_json().len() as u64;
        let budget = ReadBudget {
            max_entry_bytes: 1024 * 1024,
            total_bytes: manifest_len + 2 * 1024,
        };
        let err = read_book_bundle_with_budget(&bytes, budget).unwrap_err();
        match err {
            BundleError::TotalTooLarge { limit } => assert_eq!(limit, budget.total_bytes),
            other => panic!("expected TotalTooLarge, got {other:?}"),
        }
    }

    #[test]
    fn entries_within_budget_still_parse() {
        // The same archive under a generous budget parses (and the inflated
        // zeros make text.json invalid JSON, so expect a Json error — proof
        // the cap was NOT what rejected it).
        let bytes = archive_with_inflated_text(4 * 1024);
        let budget = ReadBudget {
            max_entry_bytes: 1024 * 1024,
            total_bytes: 1024 * 1024,
        };
        let err = read_book_bundle_with_budget(&bytes, budget).unwrap_err();
        assert!(matches!(err, BundleError::Json(_)), "got: {err:?}");
    }

    #[test]
    fn defaults_are_the_documented_budgets() {
        let b = ReadBudget::default();
        assert_eq!(b.max_entry_bytes, DEFAULT_MAX_ENTRY_BYTES);
        assert_eq!(b.total_bytes, DEFAULT_TOTAL_BYTES);
    }
}
