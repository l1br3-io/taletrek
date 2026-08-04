# Task 007: Library "Import bundle" button

**Description:** First of two UI pieces. A library-level "Import bundle" button on `LibraryPage.tsx`, mirroring the established `BackupSection.tsx` pattern (hidden `<input type="file" accept=".taletrek">`, `onChange` → read file → `importBookBundle` → toast + refresh). This is the user-facing entry point for Tier 2's "import the desktop's full bundle back."

**Acceptance criteria:**
- [ ] `web/src/components/BundleImportButton.tsx` exports a presentational component: a button (lucide `Upload` icon, `text-sm`) + a hidden `<input type="file" accept=".taletrek,.taletrek-lib">`. Props: `onImported: (report: { title: string; full: boolean }) => void`, `disabled?: boolean`. Calls back as it goes (so the page can refresh + toast).
- [ ] On file select: reads the `File` bytes, calls `readBookBundle` (T2), then `importBookBundle` (T5). Surfaces typed errors as user-readable toast text via the `BundleError` `name`/`message`: `CorruptBundleError` → "This file isn't a TaleTrek bundle"; `UnsupportedBundleKindError` → "Library bundles aren't supported yet"; `UnsupportedSchemaVersionError` → "This bundle is from a newer TaleTrek — upgrade the app"; `BundleTooLargeError` → "Not enough storage to import this bundle."
- [ ] Wired into `LibraryPage.tsx` beside `UploadButton` (line ~70). Reuses the existing toast/feedback mechanism the page already uses for uploads.
- [ ] Resets the input's value after each pick so the same file can be re-selected.
- [ ] Component test (`BundleImportButton.test.tsx`) mocks `readBookBundle`/`importBookBundle` (Testing Library): happy path calls `onImported` with the report; each error class renders the right toast text. No real ZIP I/O at this layer.

**Verification:**
- [ ] `pnpm test -- BundleImportButton` green; existing `LibraryPage` tests still green (no regressions).
- [ ] `pnpm typecheck` + `pnpm lint` clean.

**Dependencies:** T2 (reader), T5 (import). The component is presentational and mocks the lib — the lib must exist for the import path to be real, but the component tests stub it.

**Files likely touched:**
- `web/src/components/BundleImportButton.tsx` (new)
- `web/src/components/BundleImportButton.test.tsx` (new)
- `web/src/routes/library/LibraryPage.tsx` (wire the button in; small edit)

**Docs:** None.

**Estimated scope:** Small (2 new + 1 small edit; pure pattern-following on `BackupSection.tsx`).
