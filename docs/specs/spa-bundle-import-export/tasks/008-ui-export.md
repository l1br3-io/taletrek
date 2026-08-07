# Task 008: Per-book "Export bundle" action

**Description:** Second UI piece. A per-book "Export bundle" entry in `BookCard`'s existing `actionsMenu` (which already holds Rename / Transform / Hints / Re-process via callback props). Offers text-only vs full choice, then produces a browser download. Mirrors `BackupSection`'s `exportBackup() → blob → download link` flow.

**Acceptance criteria:**
- [ ] `BookCard.tsx` gains a new optional callback prop `onExportBundle?: (book: Book) => void` (or `(bookId: BookId) => void` — match the existing callback signature style). When present, the actions menu shows an "Export bundle" item (lucide `Download` icon) after the existing actions.
- [ ] `LibraryPage.tsx` (or its `useLibraryState` hook) wires `onExportBundle` to open a small chooser: "Text-only (synth elsewhere)" vs "Full (includes audio)". The chooser is a lightweight sheet/menu consistent with the page's existing `FeatureUnavailableSheet`/`OutlineSheet` patterns.
- [ ] On choice: calls `exportBookBundle(bookId, { full })` (T6) → `writeBookBundle` (T4) → `Blob` → object-URL download with default filename `<book-title>.<full|text>.taletrek` (slugified title). Revokes the object URL after download.
- [ ] `NoAudioToExportError` (from T6, full mode on a voice-less book) → toast: "This book has no audio to export. Choose text-only instead." Other `BundleError` subclasses → their toast text (shared with T7 if a helper emerges).
- [ ] Component test covers the menu item rendering + the chooser → download happy path with the lib mocked.

**Verification:**
- [ ] `pnpm test` green (new component test + no regressions in existing `BookCard`/`LibraryPage` tests).
- [ ] `pnpm typecheck` + `pnpm lint` clean.

**Dependencies:** T4 (writer), T6 (export). Soft-depends on T7 (if a shared `bundleErrorToToast` helper emerges, reuse it).

**Files likely touched:**
- `web/src/routes/library/BookCard.tsx` (add callback prop + menu item)
- `web/src/components/BundleExportAction.tsx` (new — the chooser + download orchestration, kept out of `BookCard` so the card stays presentational)
- `web/src/components/BundleExportAction.test.tsx` (new)
- `web/src/routes/library/LibraryPage.tsx` (wire `onExportBundle`)

**Docs:** None.

**Estimated scope:** Medium (1 new component + test, 2 small edits; the chooser + download orchestration is the substance).
