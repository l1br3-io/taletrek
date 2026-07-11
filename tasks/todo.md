# M5 — Library & Offline · Task checklist

> Source of truth for `/status` and `/build`. Task detail + dependencies live in
> [`plan.md`](./plan.md); spec in [`docs/prds/M5-library-offline.md`](../docs/prds/M5-library-offline.md).
> Checkpoints gate phases: A data model → B library → C resume → D offline → E PWA → F shipped.

## Phase 1 — Data model
- [x] T1 — `BookPosition` + optional `Book.position`/`progressFraction`; `getAllBooks` (newest-first), `deleteBookCascade`, `updateBookProgress`; no `DB_VERSION` bump

Checkpoint A — Data model + helpers · ✅

## Phase 2 — Library
- [x] T2 — `/library` route + `BookCover`/`BookCard`/`LibraryList` (generated covers, progress); Open/Delete; Nav + Home CTA

Checkpoint B — Library shipped · ✅

## Phase 3 — Resume
- [x] T3 — `/reader/:bookId` + resume from `Book.position`; player exposes `currentParagraph`/`currentIndex` + `initialIndex`; debounced progress writes

Checkpoint C — Resume works end-to-end · ✅

## Phase 4 — Offline
- [x] T4 — Workbox precache `+= wasm,data`; Settings "Voices & offline" (download/remove/✓); `useOnline` + `OfflineBadge`

Checkpoint D — Offline verified · ✅

## Phase 5 — PWA polish
- [x] T5 — apple-touch-icon + `<link>`; `InstallPrompt` (beforeinstallprompt + iOS instructions); iOS splash deferred (background_color covers launch)

Checkpoint E — PWA polished · ✅

## Phase 6 — End-to-end verify
- [x] T6 — E2E + browser verify (library, resume, offline, install; zero console errors, zero cdnjs, `pnpm verify` green)

Checkpoint F — M5 shipped & `pnpm verify` green · ✅

---

### Legend
- `[x]` done · `[ ]` pending · first `[ ]` is `/status`'s next task.
- Checkpoint ✅ = all tasks in the gated phases are `[x]` and verified green.
