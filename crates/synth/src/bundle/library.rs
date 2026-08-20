//! Whole-library bundle (`.taletrek-lib`) — a ZIP of a library manifest + N
//! nested book bundles.

use std::io::{Cursor, Write};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use super::error::BundleError;
use super::io::{book_bundle_to_bytes, read_book_bundle, ReadBudget};
use super::manifest::{Generator, SCHEMA_VERSION};
use super::BookBundle;

const LIBRARY_MANIFEST_ENTRY: &str = "library-manifest.json";

/// In-memory representation of a whole-library bundle.
#[derive(Debug, Clone)]
pub struct LibraryBundle {
    /// Library manifest.
    pub manifest: LibraryManifest,
    /// The constituent book bundles.
    pub books: Vec<BookBundle>,
}

/// Library-level manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryManifest {
    /// Format schema version.
    pub schema_version: u32,
    /// Discriminator — always `library`.
    pub kind: LibraryKind,
    /// Export time, ms since epoch.
    pub exported_at: u64,
    /// Number of books.
    pub book_count: u32,
    /// One entry per book.
    pub books: Vec<LibraryEntry>,
    /// Which app produced this library bundle.
    pub generator: Generator,
}

/// Library kind discriminator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryKind {
    /// A whole-library bundle.
    Library,
}

/// One book's entry in the library manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    /// Book id.
    pub id: String,
    /// Book title (for display without opening the nested bundle).
    pub title: String,
    /// Path to the nested book bundle inside the archive (`books/<id>.taletrek`).
    pub file: String,
}

/// Serialize a [`LibraryBundle`] to a `.taletrek-lib` ZIP written into `out`.
pub fn write_library_bundle(
    lib: &LibraryBundle,
    out: &mut (impl Write + std::io::Seek),
) -> Result<(), BundleError> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default();

    zip.start_file(LIBRARY_MANIFEST_ENTRY, opts)?;
    zip.write_all(&serde_json::to_vec_pretty(&lib.manifest)?)?;

    for book in &lib.books {
        let entry_file = format!("books/{}.taletrek", book.manifest.book.id);
        zip.start_file(&entry_file, opts)?;
        zip.write_all(&book_bundle_to_bytes(book)?)?;
    }

    let bytes = zip.finish()?.into_inner();
    out.write_all(&bytes)?;
    Ok(())
}

/// Parse a `.taletrek-lib` ZIP from `input` into a [`LibraryBundle`] under
/// the default [`ReadBudget`].
pub fn read_library_bundle(input: &[u8]) -> Result<LibraryBundle, BundleError> {
    read_library_bundle_with_budget(input, ReadBudget::default())
}

/// Parse a `.taletrek-lib` ZIP under a caller-supplied [`ReadBudget`]. The
/// budget bounds this archive's entries (manifest + nested-book bytes); each
/// nested book parse applies its own fresh default budget.
pub fn read_library_bundle_with_budget(
    input: &[u8],
    budget: ReadBudget,
) -> Result<LibraryBundle, BundleError> {
    let mut archive = ZipArchive::new(Cursor::new(input.to_vec()))?;
    let mut remaining = budget.total_bytes;

    let manifest: LibraryManifest = {
        let mut f = archive
            .by_name(LIBRARY_MANIFEST_ENTRY)
            .map_err(|_| BundleError::MissingEntry("library-manifest.json"))?;
        let name = f.name().to_string();
        let buf = super::io::read_capped(&mut f, &name, budget, &mut remaining)?;
        serde_json::from_slice(&buf)?
    };
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(BundleError::UnknownSchema {
            found: manifest.schema_version,
            supported: SCHEMA_VERSION,
        });
    }

    let mut books = Vec::with_capacity(usize::try_from(manifest.book_count).unwrap_or(0));
    for entry in &manifest.books {
        let bytes = read_entry(&mut archive, &entry.file, budget, &mut remaining)?;
        books.push(read_book_bundle(&bytes)?);
    }

    Ok(LibraryBundle { manifest, books })
}

/// Read a single archive entry's full bytes by name (budget-capped).
fn read_entry(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    name: &str,
    budget: ReadBudget,
    remaining: &mut u64,
) -> Result<Vec<u8>, BundleError> {
    let mut f = archive
        .by_name(name)
        .map_err(|_| BundleError::MissingEntry("nested book bundle"))?;
    let entry_name = f.name().to_string();
    super::io::read_capped(&mut f, &entry_name, budget, remaining)
}
