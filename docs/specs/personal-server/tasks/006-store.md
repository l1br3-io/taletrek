# Task 006: `store.rs` — on-disk bundle layout + `.taletrek-lib` library ingest (dedup)

**Description:** The file layer that sits beside the SQLite index (T5). Stores each book's bundle bytes at `<data_dir>/library/<book-id>/bundle.taletrek`, and ingests uploads: a single `.taletrek` (one book) or a `.taletrek-lib` (N nested books), deduping by book id (re-uploading the same id is an upsert, not a duplicate). Reuses `taletrek_synth::{read_book_bundle, read_library_bundle, BookBundle}` to extract `BookMeta` for the index and to validate every uploaded bundle. `store.rs` is pure file + bundle-parse logic; HTTP multipart wiring is T8.

**Acceptance criteria:**
- [ ] `server/src/store.rs` exposes:
  - `pub fn put_bundle(data_dir, book_id, bytes: &[u8]) -> Result<BookMeta, StoreError>` — writes `<data_dir>/library/<book_id>/bundle.taletrek` (create the dir), returns the bundle's `BookMeta` (so the caller can upsert the books row).
  - `pub fn get_bundle(data_dir, book_id) -> Result<Vec<u8>, StoreError>` — reads the bytes back (404→typed `NotFound`).
  - `pub fn delete_bundle(data_dir, book_id) -> Result<bool, StoreError>` — remove the dir; `false` if absent.
  - `pub fn ingest(data_dir, bytes: &[u8]) -> Result<Vec<BookMeta>, StoreError>` — sniffs whether `bytes` is a book bundle or a library bundle (try `read_book_bundle` first; on a `kind:"library"` discriminator fall back to `read_library_bundle` and iterate its `books`). Writes each constituent book via `put_bundle`, returns each `BookMeta`. Dedup is by `book.id`: a re-upload of the same id overwrites that book's bundle file + returns its (updated) `BookMeta` (idempotent upsert, matching the spec's "ingests N books idempotently").
  - A `StoreError` enum (`Bundle(BundleError)`, `Io(io::Error)`, `NotFound(book_id)`, plus a `NotLibraryOrBook` variant if both reads fail).
- [ ] `put_bundle` validates the bytes by parsing them (`read_book_bundle`) before writing — never writes an unparseable bundle to disk. For library bundles, each nested book is validated individually.
- [ ] The book-id is taken verbatim from the bundle's `manifest.book.id` (the server's library keys by the bundle's own id; this is **not** the SPA's allocate-new-id-on-collision policy — the server is the canonical library, so the id is stable). Doc-comment this difference.
- [ ] Path safety: `book_id` is used to build a path — reject ids containing path separators or `..` (typed error) so a malformed id can't escape `library/`.
- [ ] No HTTP in this module; it takes `data_dir: &Path` and bytes.

**Verification:**
- [ ] `cargo build` + `cargo clippy -p taletrek-server --all-targets -- -D warnings` clean.
- [ ] `cargo test -p taletrek-server` green — `store.rs` `#[cfg(test)]` using `tempfile` + the committed fixtures `crates/synth/tests/fixtures/{book-text-only.taletrek, book-full.taletrek, library.taletrek-lib}`:
  - [ ] `ingest(book-text-only bytes)` → one `BookMeta` whose `id` matches the fixture; `get_bundle` returns byte-identical bytes to the input.
  - [ ] `ingest(library bytes)` → N `BookMeta`s (one per nested book); each `get_bundle` round-trips.
  - [ ] Idempotency: `ingest` the same book twice → one book on disk (overwrite), one `BookMeta` returned.
  - [ ] `delete_bundle` removes the dir; a second `delete` returns `false`/`NotFound`.
  - [ ] Path-traversal guard: a hand-built `BookBundle` with `book.id = "../evil"` → `put_bundle` errors (typed), no file outside `library/`.
  - [ ] Corrupt bytes (not a zip) → `StoreError::Bundle` (or `NotLibraryOrBook`), nothing written.

**Dependencies:** T4 (`data_dir`), T5 (the books row the caller upserts from the returned `BookMeta` — though `store.rs` itself doesn't touch SQLite; the wiring is T8).

**Files likely touched:**
- `server/src/store.rs` (new)
- `server/Cargo.toml` (no new deps — `taletrek-synth` already pulled in T4; `tempfile` dev-dep)

**Docs:** Inline doc-comment on the **server-keys-by-bundle-id** policy (vs SPA's new-id-on-collision from effort 3) — it's a deliberate divergence and the kind of thing that's easy to "fix" wrongly later.

**Estimated scope:** Medium (1 module + fixture-driven tests; reuses existing lib I/O, the only new logic is the on-disk layout + library sniff + dedup + path guard).
