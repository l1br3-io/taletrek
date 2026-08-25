# Task 003: `datasource/local.ts` — local wrappers + parity tests

**Description:** Implement the local side of the seam: `LocalDatasource` (delegating to `lib/db` + audio/bookAudio helpers) and `LocalSynthPipeline` (delegating to `ingest.ts`, `upload/manager.ts`, `transform/manager.ts`, `reprocess.ts`). Pure delegation — no logic moves, no behavior changes. Add parity tests for the wrapper layer where existing coverage is thin (particularly the audio-probing surface used by reader UI).

**Acceptance criteria:**
- [ ] `web/src/lib/datasource/local.ts` implements both interfaces from T2 by delegating to the existing modules; `web/src/lib/datasource/index.ts` (or direct imports) exposes a singleton `localDatasource`.
- [ ] Delegation preserves exact semantics known to be load-bearing: `deleteBookCascade` atomicity, `updateBookProgress` shape, upload-job persistence via `Book.uploadJob` (G24), upload resume/boot-sweep behavior (G18).
- [ ] Parity tests (co-located `local.test.ts`, fake-indexeddb per house pattern) cover: put + list + get + delete-cascade round-trip through the facade; progress update round-trip; audio-cache probe (put entry → `getCachedParagraphIds` equivalent reports it); upload start creates a `Book` with `uploading: true` + persisted job (can follow existing upload-manager test patterns).
- [ ] `pnpm verify` green (existing suite + new tests).

**Verification:**
- [ ] `pnpm test` green including new parity tests.
- [ ] `pnpm verify` green.

**Dependencies:** T2

**Files likely touched:**
- `web/src/lib/datasource/local.ts` (new)
- `web/src/lib/datasource/local.test.ts` (new)
- `web/src/lib/datasource/index.ts` (new, optional barrel)

**Docs:** None expected.

**Estimated scope:** Medium (3-4 files)
