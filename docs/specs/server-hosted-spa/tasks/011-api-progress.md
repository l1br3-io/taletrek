# Task 011: `PATCH /api/books/:id/progress` + `books.position` + BookDto field

**Description:** The "where was I" API. Books gain a `position` JSON column (mirroring the SPA's `Book.position` shape — chapter/paragraph/scroll offsets as the SPA defines them); the endpoint is last-write-wins on `updated_at`. `BookDto` grows the field so library lists restore positions; `GET /api/books` list ordering (newest-updated-first) then also reflects reading activity, matching SPA behavior.

**Acceptance criteria:**
- [ ] Migration: `books.position` (JSON text, nullable) + included in `BookDto` (camelCase `position`) on list + get. Existing rows unaffected (null).
- [ ] `PATCH /api/books/:id/progress` (protected, JSON body = the SPA position object + optional `updatedAt` hint): validates JSON shape loosely (object, size-capped like other bodies), stores verbatim, bumps `updated_at`. `200` with the updated `BookDto`. Unknown book → `404`.
- [ ] No merging, no conflict detection — LWW by construction (locked decision); a `/** GOTCHA */` notes there is deliberately no cross-mode sync.
- [ ] SPA-side shape check: confirm `Book.position`'s TS type and store exactly that (task includes writing the mirrored TS type into the task notes or a shared doc comment — the ServerDatasource (T13) consumes it).
- [ ] Tests: PATCH round-trip (set → list/get returns it), 404 path, oversized/garbage body → 400, auth required; migration test (old row → null position → PATCH → populated).

**Verification:**
- [ ] `cargo clippy` + `cargo test -p taletrek-server` green.
- [ ] Manual curl round-trip on a fixture book.

**Dependencies:** None (parallel-friendly)

**Files likely touched:**
- `server/src/db.rs` (migration, queries, `BookRow`)
- `server/src/http/books.rs` (PATCH handler, DTO)
- `server/src/http/mod.rs` (route)

**Docs:** LWW/no-sync contract → `/** GOTCHA */` in the handler.

**Estimated scope:** Medium (3 files)
