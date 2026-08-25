# Task 014: Remote synth pipeline — parse → text-only bundle → POST → synth → poll

**Description:** The hosted upload path. Reuse the existing parse workers; instead of running `uploadManager`, serialize the parsed book to an **in-memory text-only bundle** via the existing `lib/bundle/writer` (T3 surface), `POST /api/books` (multipart), `POST /api/books/:id/synth` (voice from `GET /api/voices`), then poll `GET /api/jobs/:id` feeding the existing `Book.processing` display shapes. Covers the transform corner: AI transform happens client-side before first POST; a re-transform after synth re-POSTs the text-only bundle (same book id → idempotent upsert) then triggers `resynth` with the book's current voice.

**Acceptance criteria:**
- [ ] `RemoteSynthPipeline` (completing the `SynthPipeline` interface): start (parse → bundle bytes → POST → synth → poll loop), cancel (stop polling; job keeps running server-side — document), transform-submit (re-POST + resynth), reprocess equivalent (resynth with same/default voice). No wake lock, no PoolEngine, no mobile whole-book encode in this path.
- [ ] Bundle construction writes the SPA's existing manifest/text shapes (writer reuse — G27's whole-archive-in-memory note does not apply to *writing* text-only, which is small).
- [ ] Progress surfacing maps `JobDto { done, total, status, error }` onto the same UI states the local pipeline produces (variant types; job failure → the existing error surface).
- [ ] Reload recovery (R5): on boot in server mode, books whose `processing` indicates an in-flight job recover status via `GET /api/jobs` (recent-50) matched by book id; completed-while-away → book shows ready.
- [ ] Vitest mocked-fetch: POST/synth/poll happy path; 409 already-running; 413 oversize; job failure surfaces error; recovery matrix.
- [ ] Manual (`just dev`, seeded piper): upload EPUB in hosted mode → 202 → progress ticks → completes; close the tab mid-job (server keeps running) → job completes (curl-verified) → reopen → book ready.

**Verification:**
- [ ] `pnpm test` + `pnpm verify` green.
- [ ] Manual walkthrough above (this is the effort's headline demo — record result in todo.md notes).

**Dependencies:** T13

**Files likely touched:**
- `web/src/lib/datasource/server.ts` (pipeline half) + tests
- `web/src/lib/bundle/writer.ts` (only if a text-only-variant entry point needs exporting — no format change)
- `web/src/routes/library/useLibraryState.ts` (upload dispatch — mode-agnostic via pipeline interface; ideally untouched since T5)

**Docs:** "cancel = stop polling, job continues" contract → doc comment on cancel().

**Estimated scope:** Large (3-5 files but dense) — split "upload+POST+synth" from "poll/recovery/transform-resubmit" into two commits if needed.
