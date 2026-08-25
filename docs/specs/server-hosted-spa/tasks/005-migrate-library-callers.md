# Task 005: Migrate library-path callers through the facade

**Description:** Second migration slice: the library route's hooks and their orchestration entry points. `useLibraryState` (+ `useAiTransform`, `useOutline`, `usePronunciationHints`) switch from `lib/db`/`ingest`/`reprocess`/upload-manager singletons to the `LocalSynthPipeline` + `LocalDatasource` facade. The hooks keep their external API (states, handlers) — only the data-layer calls are re-pointed. `ingest.ts`/`upload/manager.ts`/`transform/manager.ts` themselves keep direct `lib/db` access (they *are* the local implementation).

**Acceptance criteria:**
- [ ] `routes/library/` hooks no longer import from `lib/db` or `lib/ingest`; upload start/resume/cancel, transform submit, reprocess, and book delete/progress go through the pipeline/datasource interfaces.
- [ ] Behavior identical: wake-lock upload flow (G18), pausable synth persistence (G24), pool pre-synth (G25), AI transform round-trip, outline/hints flows.
- [ ] Existing library-route tests green, assertions untouched (import-path-only edits allowed).
- [ ] `uploadManager`'s `useSyncExternalStore` subscription surface stays consumable by `useUpload` through the pipeline wrapper (no re-subscribe churn).

**Verification:**
- [ ] `pnpm test` green.
- [ ] `pnpm verify` green.
- [ ] Manual smoke: upload a small EPUB → synth → progress ticks → done; pause/resume mid-synth; transform a chapter.

**Dependencies:** T3 (T4 recommended first — same-area import edits, avoid merge friction on separate sessions)

**Files likely touched:**
- `web/src/routes/library/useLibraryState.ts`
- `web/src/routes/library/useAiTransform.ts`
- `web/src/routes/library/useOutline.ts`
- `web/src/routes/library/usePronunciationHints.ts`
- `web/src/hooks/useUpload.ts` (if it imports the manager directly)

**Docs:** None expected.

**Estimated scope:** Medium (4-5 files)
