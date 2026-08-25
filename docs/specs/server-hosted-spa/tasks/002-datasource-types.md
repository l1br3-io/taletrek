# Task 002: `datasource/types.ts` — `LibraryDatasource` + `SynthPipeline` interfaces

**Description:** Design the datasource seam from the *actual* call-site inventory, not from imagination. Two interfaces: `LibraryDatasource` (library reads/writes the UI performs) and `SynthPipeline` (upload/transform/synth orchestration the UI triggers). The surface must cover: books CRUD + progress + processing-state patches, chapter reads/writes, cached-audio probing (for buffered indicators), whole-book audio reads (mobile preloaded player), upload start/resume/cancel, AI-transform submit, and re-processing triggers. Everything settings/keyring stays **out** (locked: those remain IDB in both modes). This task adds types only — no callers move, zero runtime change.

**Acceptance criteria:**
- [ ] `web/src/lib/datasource/types.ts` exports `LibraryDatasource` + `SynthPipeline` (plus any shared async-state/variant types they need), interfaces-before-impl, strict TS, branded IDs preserved (`BookId`, `ChapterId`).
- [ ] Every method maps 1:1 onto an existing `lib/db` / upload-manager capability used by UI (inventory in plan/research: `getAllBooks`, `getBook`, `deleteBookCascade`, `updateBookProgress`, `updateBookProcessing`, `getMostRecentBook`, `getChaptersByBook`, `replaceBookChapters`, `updateParagraph`, audio probing via `getCachedParagraphIds`/`getBookAudio`, upload start/resume, transform submit). No speculative methods without a caller.
- [ ] Async results use the house variant pattern (`{ type: 'loading' } | { type: 'ready'; data }`) where the UI already models it; plain promises where callers use plain promises (match existing call sites — don't invent ceremony).
- [ ] A short module doc comment states the boundary contract: UI imports from `lib/datasource` only; `lib/db` remains importable by lib internals + the settings/secureKeyring allowlist.
- [ ] `pnpm typecheck` green; no other file changed (except re-export barrel if one is added).

**Verification:**
- [ ] `pnpm typecheck` + `pnpm lint` green.
- [ ] `git status` — only `web/src/lib/datasource/` touched.

**Dependencies:** None (conceptually after T1 so the ADR exists; not a code dependency).

**Files likely touched:**
- `web/src/lib/datasource/types.ts` (new)

**Docs:** Boundary contract lives in the module doc comment (the code home). AGENTS.md layout section gets its `lib/` line extended with `datasource/` only when the effort ships (T19), not now.

**Estimated scope:** Small (1-2 files)
