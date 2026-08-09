# Task 008: `POST /api/books` (multipart upload + ingest) + download + delete

**Description:** Completes the library CRUD vertical slice: upload, download, delete. `POST /api/books` accepts a multipart upload (one `.taletrek` or `.taletrek-lib`), ingests it via `store::ingest` (T6 — handles both bundle kinds + dedup), upserts each constituent book's `BookMeta` into the SQLite index, and returns the ingested book metadata. Download streams the stored bundle bytes back; delete removes the bundle file + its index row. End result: a curl round-trip — upload → list → download (byte-identical) → delete.

**Acceptance criteria:**
- [ ] `server/src/http/books.rs` (extended) adds:
  - `POST /api/books` — `multipart/form-data` field `bundle` (the file bytes). Reads the field, calls `store::ingest(&data_dir, bytes)`, and for each returned `BookMeta` calls `Db::upsert_book(BookRow::from(meta))`. Returns `201` with the array of ingested book metadata (camelCase JSON). Malformed/non-bundle upload → `400` with the `StoreError` rendered.
  - `GET /api/books/:id/bundle` — streams the stored bundle bytes (`store::get_bundle`) with `Content-Type: application/zip` and `Content-Disposition: attachment; filename="<id>.taletrek"`. Unknown id → `404`.
  - `DELETE /api/books/:id` — `store::delete_bundle` + `Db::delete_book`; returns `204` whether or not the book existed (idempotent delete) or `404` if you choose strict — pick idempotent `204` and document it.
- [ ] All three handlers run their `store`/`Db` work inside `tokio::task::spawn_blocking` (rusqlite + file I/O are blocking). Extract a small helper so the pattern is uniform.
- [ ] `BookRow::from(BookMeta)` maps the bundle's `BookMeta` → the books row, setting `created_at`/`updated_at` (created_at preserved on re-ingest if the row existed; updated_at bumped to now).
- [ ] Multipart is parsed with axum's `Multipart` extractor (the `multipart` feature was added in T4). Size: rely on axum's default body limit raised to a generous bound (bundles can be tens of MiB; document the limit and make it configurable via `Settings` if cheap — otherwise a fixed sensible default + a `413` on overflow).
- [ ] `AppState` now holds the real `data_dir: PathBuf` (or a `Store` handle wrapping it) so handlers can reach `store::ingest/get_bundle/delete_bundle`.

**Verification:**
- [ ] `cargo build` + `cargo clippy -p taletrek-server --all-targets -- -D warnings` clean.
- [ ] `cargo test -p taletrek-server` green (stub `Db` + real `store` against `tempfile` data_dir):
  - [ ] Upload the committed `book-text-only.taletrek` fixture (multipart) → `201`, one book in the response; `GET /api/books` now lists it; `GET .../bundle` returns bytes byte-identical to the fixture; `DELETE` → `204`; `GET /api/books` now empty.
  - [ ] Upload the `library.taletrek-lib` fixture → `201` with N books; each is independently listable + downloadable.
  - [ ] Dedup: upload the same book twice → still one book (idempotent upsert), not two.
  - [ ] Auth still required (reuse T7's test server).
  - [ ] Download of an unknown id → `404`; upload of garbage bytes → `400`.
- [ ] Manual (curl round-trip):
  ```
  curl -H "Authorization: Bearer $T" -F "bundle=@book-text-only.taletrek" http://127.0.0.1:7878/api/books
  curl -H "Authorization: Bearer $T" http://127.0.0.1:7878/api/books
  curl -H "Authorization: Bearer $T" -o out.taletrek http://127.0.0.1:7878/api/books/<id>/bundle
  cmp book-text-only.taletrek out.taletrek   # byte-identical
  ```

**Dependencies:** T5 (`Db::upsert_book/delete_book`, `BookRow`), T6 (`store::ingest/get_bundle/delete_bundle`), T7 (router + auth + `AppState`).

**Files likely touched:**
- `server/src/http/books.rs` (add upload/download/delete handlers)
- `server/src/http/mod.rs` (route the new handlers; finalize `AppState` fields)
- `server/src/main.rs` (construct `AppState` with `data_dir`/`Db`/`Store`)
- `server/Cargo.toml` (confirm `axum` `multipart` feature; body-limit config if added)

**Docs:** The idempotent-upsert-by-book-id policy (vs SPA's new-id-on-collision) is already documented in `store.rs` (T6); cross-reference it from the upload handler. A `/** GOTCHA */` on the request body size limit for large full bundles.

**Estimated scope:** Medium–Large (3 handlers + multipart + spawn_blocking plumbing + the curl round-trip). If multipart parsing proves fiddly in build, split download+delete (simple) from upload (multipart) — but try it as one slice first; the round-trip test is what proves the layer.
