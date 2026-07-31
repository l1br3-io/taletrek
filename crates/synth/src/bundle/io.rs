//! Book-bundle read/write (ZIP container). See `docs/bundle-format.md`.

use std::io::{Cursor, Read, Seek, Write};

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

/// Serialize `bundle` to a `.taletrek` ZIP written into `out`.
pub fn write_book_bundle(
    bundle: &BookBundle,
    out: &mut (impl Write + Seek),
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

/// Parse a `.taletrek` ZIP from `input` into a [`BookBundle`].
///
/// Accepts both text-only and full bundles. A `schemaVersion` this reader does
/// not understand yields [`BundleError::UnknownSchema`].
pub fn read_book_bundle(input: &[u8]) -> Result<BookBundle, BundleError> {
    let mut archive = ZipArchive::new(Cursor::new(input.to_vec()))?;

    let manifest: Manifest = read_json_entry(&mut archive, MANIFEST_ENTRY, "manifest.json")?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(BundleError::UnknownSchema {
            found: manifest.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    let text: TextFile = read_json_entry(&mut archive, TEXT_ENTRY, "text.json")?;

    // Audio segments are optional (text-only bundle). Scan only when the
    // manifest declares audio present.
    let mut audio = std::collections::HashMap::new();
    if manifest.audio.present {
        for i in 0..archive.len() {
            let mut f = archive.by_index(i)?;
            let name = f.name().to_string();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
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
) -> Result<T, BundleError> {
    let mut f = archive
        .by_name(name)
        .map_err(|_| BundleError::MissingEntry(missing))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(serde_json::from_slice(&buf)?)
}
