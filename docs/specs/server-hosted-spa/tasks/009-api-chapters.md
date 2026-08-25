# Task 009: Chapters — lazy SQLite explode + `GET /api/books/:id/chapters`

**Description:** The reading API: the hosted SPA needs chapter/paragraph text without downloading the whole bundle. On first request per book, explode the bundle's `text.json` into a `chapters` table (per-chapter rows, paragraphs as a JSON array — matching the SPA `Chapter` shape), then serve from SQLite. Lazy explode keeps effort-4-era libraries working with no boot sweep; re-explode when the stored bundle's `updated_at` moves (post-resynth rewrite).

**Acceptance criteria:**
- [ ] Migration: `chapters` table (`book_id`, `idx`, `title`, `paragraphs` JSON, PK `(book_id, idx)`); books row gains an `exploded_at` timestamp (or equivalent version marker).
- [ ] `GET /api/books/:id/chapters` (protected): if not exploded or bundle newer than explode marker → read bundle from disk (spawn_blocking), parse `text.json`, upsert rows, mark exploded; return `200` camelCase array `[{ id, bookId, idx, title, paragraphs }]` (ids: stable derived form — chapter rows keyed by book+idx; expose an id the SPA can treat as `ChapterId`).
- [ ] `404` unknown book; `500`-mapped store errors as elsewhere; concurrent first-hits on the same book don't double-explode visibly (upsert idempotent — last writer wins, rows are deterministic from the same bundle).
- [ ] Resynth/synth rewrite of a bundle invalidates the marker (hook where the bundle is atomically re-written in `synth.rs` or compare `updated_at` on each request — pick compare-on-request, no coupling).
- [ ] Tests (in-process, fixture bundle from `crates/synth/tests/fixtures/`): first call explodes + returns chapters matching the fixture's `text.json`; second call served from SQLite (can assert via row count / a mutate-and-refetch trick); post-update re-explode; 404 path.

**Verification:**
- [ ] `cargo clippy` + `cargo test -p taletrek-server` green.
- [ ] Manual curl: upload text-only fixture → `GET .../chapters` twice → identical JSON, `taletrek.db` gains rows.

**Dependencies:** None (effort-4 codebase; T8 parallel-friendly)

**Files likely touched:**
- `server/src/db.rs` (migration + chapter queries)
- `server/src/http/chapters.rs` (new)
- `server/src/http/mod.rs` (route)
- `server/src/store.rs` (text.json extraction helper, likely exists in synth crate I/O — reuse, don't re-parse zip by hand if `crates/synth` exposes it)

**Docs:** None expected.

**Estimated scope:** Medium (3-5 files)
