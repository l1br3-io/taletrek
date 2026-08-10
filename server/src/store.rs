//! On-disk bundle store — `<data_dir>/library/<book-id>/bundle.taletrek`.
//!
//! The file layer that sits beside the SQLite index (T5). [`put_bundle`] writes
//! a validated book bundle to disk keyed by book id; [`ingest`] accepts either a
//! single-book `.taletrek` or a whole-library `.taletrek-lib` and stores every
//! constituent book. HTTP multipart wiring lands in T8; this module is pure
//! file + bundle-parse logic (takes `&Path` + bytes, no HTTP).
//!
//! # The server keys by the bundle's own book id (NOT the SPA's policy)
//!
//! GOTCHA: the server stores each book at `<data_dir>/library/<book.id>/…`,
//! taking `book.id` **verbatim from the bundle's own manifest**. This is a
//! deliberate divergence from the SPA's import policy (effort 3), which
//! allocates a fresh id when an incoming id collides with one already in the
//! device library. The server is the *canonical* library — its ids are stable —
//! so a re-upload of the same id is an **idempotent upsert** (overwrite), not a
//! new book. Do not "fix" this to mirror the SPA; the two sides are
//! intentionally different. See the policy doc on [`put_bundle`].
//!
//! # Path safety
//!
//! `book_id` becomes a path component, so every entry point runs it through
//! [`validate_book_id`], which rejects ids that are empty, equal `.`/`..`, or
//! contain path separators / `..` / NUL — a malformed id can never escape
//! `library/`.
//!
//! # Dead-code window (T6 → T8)
//!
//! This module's public API is proven in isolation here but is not wired into
//! the axum app until T8 (the upload handler). Until then the bin-crate
//! dead-code analysis flags these items; the allow below is scoped to this
//! module and should be removed once T8 consumes the API.
#![allow(dead_code)]

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use taletrek_synth::{
    read_book_bundle, read_library_bundle, write_book_bundle, BookMeta, BundleError,
};

/// Errors surfaced by the store layer.
///
/// Kept small and typed so HTTP handlers (T8) can map [`Self::NotFound`] → 404,
/// [`Self::InvalidBookId`] → 400, [`Self::NotLibraryOrBook`] → 400, etc. Nothing
/// here knows about HTTP.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// A bundle failed to parse (corrupt zip, bad JSON, unknown schema, …).
    #[error("bundle parse error: {0}")]
    Bundle(#[from] BundleError),
    /// A filesystem operation failed (read/write/create_dir).
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// The requested book id has no bundle on disk (→ 404 in T8).
    #[error("book not found in store: {0}")]
    NotFound(String),
    /// The uploaded bytes parsed as neither a book nor a library bundle. Both
    /// underlying read errors are kept for diagnostics.
    #[error(
        "bytes are neither a book nor a library bundle (book read: {book}; library read: {library})"
    )]
    NotLibraryOrBook {
        /// Why the bytes failed to parse as a single-book bundle.
        book: BundleError,
        /// Why the bytes failed to parse as a library bundle.
        library: BundleError,
    },
    /// The book id is not a safe single path component (empty, `.`, `..`,
    /// contains a separator, `..`, or NUL) — rejected to prevent escaping
    /// `library/` (→ 400 in T8).
    #[error(
        "invalid book id {0:?}: must be non-empty and must not contain path separators, '..', or NUL"
    )]
    InvalidBookId(String),
}

/// `<data_dir>/library/<book_id>/bundle.taletrek`.
fn bundle_file(data_dir: &Path, book_id: &str) -> PathBuf {
    data_dir
        .join("library")
        .join(book_id)
        .join("bundle.taletrek")
}

/// Reject book ids that could escape `library/`.
///
/// A book id is used verbatim as a path component, so it must be a single safe
/// segment. This guards against `../evil`, absolute-ish fragments, NUL, and the
/// empty string. Real ids are branded hex/uuid strings and always pass.
fn validate_book_id(id: &str) -> Result<(), StoreError> {
    if id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || id.contains('\0')
        || id.contains("..")
    {
        return Err(StoreError::InvalidBookId(id.to_string()));
    }
    Ok(())
}

/// Write a book bundle to `<data_dir>/library/<book_id>/bundle.taletrek`.
///
/// `bytes` are validated by parsing them (`read_book_bundle`) **before** any
/// file is written — an unparseable bundle never reaches disk. The original
/// `bytes` are written verbatim (no re-serialization), so a subsequent
/// [`get_bundle`] returns byte-identical input. Returns the bundle's parsed
/// [`BookMeta`] so the caller (T8) can upsert the SQLite `books` row.
///
/// `book_id` is validated by [`validate_book_id`]. The caller is expected to
/// pass `bundle.manifest.book.id` — see the module docs on the server-keys-by-
/// bundle-id policy (a deliberate divergence from the SPA's
/// allocate-new-id-on-collision from effort 3; the server is canonical, so the
/// id is stable and a re-upload overwrites in place).
pub fn put_bundle(data_dir: &Path, book_id: &str, bytes: &[u8]) -> Result<BookMeta, StoreError> {
    validate_book_id(book_id)?;
    let bundle = read_book_bundle(bytes)?;
    let path = bundle_file(data_dir, book_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, bytes)?;
    Ok(bundle.manifest.book)
}

/// Read a stored book bundle's bytes back. `NotFound` if absent.
pub fn get_bundle(data_dir: &Path, book_id: &str) -> Result<Vec<u8>, StoreError> {
    validate_book_id(book_id)?;
    let path = bundle_file(data_dir, book_id);
    match fs::read(&path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(StoreError::NotFound(book_id.to_string()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Remove a book's directory. Returns `false` if the book was already absent
/// (no error — idempotent delete).
pub fn delete_bundle(data_dir: &Path, book_id: &str) -> Result<bool, StoreError> {
    validate_book_id(book_id)?;
    let dir = data_dir.join("library").join(book_id);
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Store an uploaded `.taletrek` (one book) or `.taletrek-lib` (N books).
///
/// Sniffs the kind by attempting `read_book_bundle` first; if that fails the
/// bytes are tried as a library bundle via `read_library_bundle`. Each
/// constituent book is written via [`put_bundle`] under its own
/// `manifest.book.id`, overwriting any prior bundle for that id (idempotent
/// upsert). Returns every stored book's [`BookMeta`] in archive order.
///
/// If the bytes parse as neither, [`StoreError::NotLibraryOrBook`] is returned
/// and nothing is written.
pub fn ingest(data_dir: &Path, bytes: &[u8]) -> Result<Vec<BookMeta>, StoreError> {
    match read_book_bundle(bytes) {
        Ok(bundle) => {
            let id = bundle.manifest.book.id.clone();
            let meta = put_bundle(data_dir, &id, bytes)?;
            Ok(vec![meta])
        }
        Err(book_err) => match read_library_bundle(bytes) {
            Ok(lib) => {
                let mut metas = Vec::with_capacity(lib.books.len());
                for book in lib.books {
                    let id = book.manifest.book.id.clone();
                    // Re-serialize each nested book; put_bundle re-validates +
                    // writes verbatim under the book's own id.
                    let mut cursor = Cursor::new(Vec::new());
                    write_book_bundle(&book, &mut cursor)?;
                    let book_bytes = cursor.into_inner();
                    metas.push(put_bundle(data_dir, &id, &book_bytes)?);
                }
                Ok(metas)
            }
            Err(lib_err) => Err(StoreError::NotLibraryOrBook {
                book: book_err,
                library: lib_err,
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared fixtures from crates/synth (effort 1). `include_bytes!` resolves
    // relative to this file (server/src/store.rs → two `..` reaches the repo
    // root).
    const BOOK_TEXT_ONLY: &[u8] =
        include_bytes!("../../crates/synth/tests/fixtures/book-text-only.taletrek");
    const BOOK_FULL: &[u8] = include_bytes!("../../crates/synth/tests/fixtures/book-full.taletrek");
    const LIBRARY: &[u8] = include_bytes!("../../crates/synth/tests/fixtures/library.taletrek-lib");

    // ---- ingest: single book ----

    #[test]
    fn ingest_book_round_trips_byte_identical() {
        let tmp = tempfile::tempdir().unwrap();
        let direct = read_book_bundle(BOOK_TEXT_ONLY).unwrap();
        let metas = ingest(tmp.path(), BOOK_TEXT_ONLY).unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].id, direct.manifest.book.id);
        assert_eq!(metas[0].title, direct.manifest.book.title);
        // get_bundle returns byte-identical input (verbatim write, no re-encode).
        let stored = get_bundle(tmp.path(), &metas[0].id).unwrap();
        assert_eq!(stored.as_slice(), BOOK_TEXT_ONLY);
    }

    #[test]
    fn ingest_full_book_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let metas = ingest(tmp.path(), BOOK_FULL).unwrap();
        assert_eq!(metas.len(), 1);
        let stored = get_bundle(tmp.path(), &metas[0].id).unwrap();
        assert_eq!(stored.as_slice(), BOOK_FULL);
        // The stored bundle still declares audio present.
        let reparsed = read_book_bundle(&stored).unwrap();
        assert!(reparsed.manifest.audio.present);
    }

    // ---- ingest: library ----

    #[test]
    fn ingest_library_yields_each_book_and_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = read_library_bundle(LIBRARY).unwrap();
        assert!(!lib.books.is_empty(), "fixture should carry >=1 book");
        let metas = ingest(tmp.path(), LIBRARY).unwrap();
        assert_eq!(metas.len(), lib.books.len());
        for (meta, book) in metas.iter().zip(lib.books.iter()) {
            assert_eq!(meta.id, book.manifest.book.id);
            assert_eq!(meta.title, book.manifest.book.title);
            let stored = get_bundle(tmp.path(), &meta.id).unwrap();
            let reparsed = read_book_bundle(&stored).unwrap();
            assert_eq!(reparsed.manifest.book.id, book.manifest.book.id);
            assert_eq!(reparsed.manifest.book.title, book.manifest.book.title);
        }
    }

    // ---- idempotency (dedup by book id) ----

    #[test]
    fn ingest_same_book_twice_is_an_upsert() {
        let tmp = tempfile::tempdir().unwrap();
        let first = ingest(tmp.path(), BOOK_TEXT_ONLY).unwrap();
        let second = ingest(tmp.path(), BOOK_TEXT_ONLY).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].id, second[0].id);
        // Exactly one book dir on disk — overwrite, not duplicate.
        let count = fs::read_dir(tmp.path().join("library")).unwrap().count();
        assert_eq!(count, 1);
    }

    // ---- delete ----

    #[test]
    fn delete_bundle_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let metas = ingest(tmp.path(), BOOK_TEXT_ONLY).unwrap();
        let id = &metas[0].id;
        assert!(
            delete_bundle(tmp.path(), id).unwrap(),
            "first delete removes"
        );
        assert!(
            !delete_bundle(tmp.path(), id).unwrap(),
            "second delete returns false (already absent)"
        );
        // get_bundle now NotFound.
        let err = get_bundle(tmp.path(), id).unwrap_err();
        assert!(matches!(err, StoreError::NotFound(_)), "got: {err}");
    }

    // ---- path-traversal guard ----

    #[test]
    fn put_bundle_rejects_traversal_id() {
        let tmp = tempfile::tempdir().unwrap();
        let err = put_bundle(tmp.path(), "../evil", BOOK_TEXT_ONLY).unwrap_err();
        assert!(matches!(err, StoreError::InvalidBookId(_)), "got: {err}");
        // Nothing written — library/ not even created.
        assert!(!tmp.path().join("library").exists());
    }

    #[test]
    fn put_bundle_rejects_other_unsafe_ids() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["", ".", "..", "a/b", "a\\b", "a..b", "x\0y"] {
            let err = put_bundle(tmp.path(), bad, BOOK_TEXT_ONLY).unwrap_err();
            assert!(
                matches!(err, StoreError::InvalidBookId(_)),
                "id {bad:?} should be rejected; got {err}"
            );
        }
        assert!(!tmp.path().join("library").exists());
    }

    // ---- corrupt input ----

    #[test]
    fn corrupt_bytes_are_neither_book_nor_library() {
        let tmp = tempfile::tempdir().unwrap();
        let err = ingest(tmp.path(), b"definitely not a zip").unwrap_err();
        assert!(
            matches!(err, StoreError::NotLibraryOrBook { .. }),
            "got: {err}"
        );
        // Nothing written.
        assert!(!tmp.path().join("library").exists());
    }

    #[test]
    fn put_bundle_validates_bytes_before_writing() {
        let tmp = tempfile::tempdir().unwrap();
        // Valid id but corrupt bytes → parse fails → nothing written.
        let err = put_bundle(tmp.path(), "some-valid-id", b"not a zip").unwrap_err();
        assert!(matches!(err, StoreError::Bundle(_)), "got: {err}");
        assert!(!tmp.path().join("library").join("some-valid-id").exists());
    }

    #[test]
    fn get_bundle_missing_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let err = get_bundle(tmp.path(), "absent").unwrap_err();
        assert!(matches!(err, StoreError::NotFound(_)), "got: {err}");
    }
}
