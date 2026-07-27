---
status: shipped
started: 2026-07-12
shipped: 2026-07-12
---

# PRD: M5 — Library & Offline

> **Companions:** [`../../VISION.md`](../../VISION.md), [`../../ROADMAP.md`](../../ROADMAP.md), [`../foundation/spec.md`](../foundation/spec.md), [`../upload-read/spec.md`](../upload-read/spec.md), [`../speak/spec.md`](../speak/spec.md), [`../jog-mode/spec.md`](../jog-mode/spec.md), [`../clean-reading/spec.md`](../clean-reading/spec.md), [`../../adrs/0002-mit-piper-pipeline.md`](../../adrs/0002-mit-piper-pipeline.md).

## Objective

Turn TaleTrek from a single-book reader into a **complete reading companion**. Four pillars:

1. **Library** — a dedicated `/library` route listing the reader's full book collection as cards with generated covers, titles, last-read position, and progress.
2. **Progress & resume** — reading/playback position persists per book; reopening a book resumes exactly where the reader left off, days later, across reloads.
3. **Offline** — verify and surface true offline: Piper voice models already cache in OPFS; fix the Workbox precache so the Piper WASM runtime is available offline; add a voice-management UI and an offline-ready indicator.
4. **PWA polish** — apple-touch-icon, iOS splash screens, and an install prompt so the app feels like a first-class installable citizen.

This milestone **does not change** parsing, cleaning, or playback engine behavior. It adds a library layer on top of M1's storage, a progress layer on top of M3's player, an offline/voice-management layer on top of M2's TTS, and a polish layer on top of M0's PWA shell.

**User story:** *As a reader, I open TaleTrek and see my whole collection. I tap a book and it jumps to where I stopped. On a flight with no signal, I keep listening — the voice model is already on my device. I install TaleTrek to my home screen and it launches full-screen like a real app.*

## Decisions (locked)

| Area | Decision |
| ---- | -------- |
| Library placement | **New `/library` route.** Home stays as the landing/marketing page and gains a "Your library" CTA. Non-destructive; marketing + app coexist. |
| Covers | **Generated typography covers.** Each card renders the title's initials (2–3 chars) on the accent gradient — pure CSS, every format, zero storage cost, on-brand. No image extraction from EPUBs/MOBIs (deferred). |
| Reader routing | **`/reader/:bookId`** — deep-linkable, so the library's Open action and Home's "Continue reading" target a specific book. Bare `/reader` redirects to `/reader/<latest>` (or `/library` when no book exists). |
| Progress model | **Additive fields on `Book`** — `position?: BookPosition` and `progressFraction?: number`. Object-store values are schemaless, so existing books read with these `undefined` → treated as "not started". **Zero migration code, no `DB_VERSION` bump** (mirrors M4's `cleaning` addition). |
| Progress persistence | **Debounced writes from the player's current position.** The reader container watches `player.currentIndex`; writes `Book.position` + `progressFraction` + bumps `updatedAt` at most once every few seconds, plus a final write on pause/stop/unmount. `updatedAt` feeds `getMostRecentBook` + library sort order. |
| Player position output | `useParagraphPlayer` exposes **`currentParagraph: ParagraphRef \| null`** and **`currentIndex: number \| null`** (it already tracks `pointerRef`). The reader derives `(chapterIndex, paragraphIndex)` + fraction from these — no id-string parsing. |
| Resume semantics | On open, seed the player pointer from saved `position`, matched against the **cleaned** paragraph stream by `chapterId:paragraphIndex`. If cleaning drifted the index out of range, fall back to clamped flat index → `{0,0}`. Position is into the displayed (cleaned) stream; that is what the reader sees/hears. |
| Offline (models) | **Unchanged — already OPFS.** Piper models download to OPFS via `piper.download()`/`stored()` (M2). No storage change. M5 adds the UX to manage and verify this. |
| Offline (WASM runtime) | **Fix Workbox precache.** `globPatterns` currently omits `.wasm`/`.data`, so the Piper runtime in `public/wasm/` is **not** precached — true offline first-load TTS fails today. M5 adds `wasm,data` (or a runtime-cache rule for `/wasm/**`) so the runtime is available offline after first load. |
| Voice management | **Settings subsection "Voices & offline"** — lists the curated catalog; each row shows name, size, and Download/Remove/✓ state via `ttsClient.isStored`/`download`(progress)/`remove`. |
| Offline indicator | A small **online/offline + ready badge** (header or settings) driven by `navigator.onLine` + whether the active voice is stored. Subscribes to `online`/`offline` events for live updates. |
| PWA: apple-touch-icon | Add `<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">` to `index.html`. Generated from the existing icon source via `scripts/gen-icons.mjs`. |
| PWA: iOS splash | Generate a **minimal set** of `apple-touch-startup-image` entries (latest iPhone portrait sizes) via `scripts/gen-icons.mjs`; add the `<link>` tags. Trailing/trimmable if it grows large. |
| PWA: install prompt | Capture `beforeinstallprompt`; surface a dismissible "Install TaleTrek" affordance (sticky dismissal via settings flag). On iOS (no `beforeinstallprompt`), show "Share → Add to Home Screen" instructions when standalone detection is false. |
| Author field | **Deferred (non-goal).** Parsers return `title` only. Library cards show title + format + progress. Threading `author` through `ParseResult` is a future pass. |
| Licensing | ADR-0002 (MIT pipeline) unchanged; no new dependencies. |

## Technologies (additions to M0–M4)

| Package | Version | License | Purpose |
| ------- | ------- | ------- | ------- |
| — | — | — | **No new dependencies.** M5 is existing React Router params, existing `idb`, existing `vite-plugin-pwa` (Workbox config), existing TTS client, and a small icon-generation script. |

Adding dependencies is ask-first per M0 boundaries.

## Domain model (additions)

```ts
/** Saved reading/playback position within a book (into the cleaned stream). */
interface BookPosition {
  chapterIndex: number
  paragraphIndex: number
}

interface Book {
  // ...existing fields (id, title, format, chapterCount, createdAt, updatedAt)
  /** Last reading position; `undefined` means not started. */
  position?: BookPosition
  /** Fraction of paragraphs consumed (0..1), for the library progress bar. */
  progressFraction?: number
}
```

New **db helpers** (additive, no schema change):

```ts
/** All books, newest-first by updatedAt (uses the existing index). */
function getAllBooks(): Promise<Book[]>

/** Delete a book and all of its chapters + uploaded file (single tx). */
function deleteBookCascade(id: BookId): Promise<void>

/** Lightweight progress write — also bumps updatedAt. */
function updateBookProgress(
  id: BookId,
  position: BookPosition,
  progressFraction: number,
): Promise<void>
```

New **player outputs**:

```ts
interface UseParagraphPlayerResult {
  // ...existing
  /** The paragraph currently being played/pointed at, or null when idle. */
  currentParagraph: ParagraphRef | null
  /** Flat index of the pointer, or null when idle. */
  currentIndex: number | null
}
```

## Architecture

```
/lib
  db.ts                  + getAllBooks, deleteBookCascade, updateBookProgress
  storage.ts             (unchanged — persistence helpers already present)
  tts/                   (unchanged engine/worker; client already exposes
                           isStored/download/remove)

/routes
  landing.tsx            + "Your library" CTA, + "Continue reading" shortcut
  library.tsx          NEW — grid of BookCard; Open → /reader/:bookId; Delete
  reader.tsx             /reader/:bookId; resume from Book.position;
                          debounced progress writes from player.currentIndex
  settings.tsx           + "Voices & offline" subsection + install prompt

/components
  BookCover.tsx        NEW — presentational: title initials on accent gradient
  BookCard.tsx         NEW — presentational: cover + title + format + progress
  LibraryList.tsx      NEW — presentational: grid + empty state (container
                          fetches books)
  Nav.tsx               + Library link
  OfflineBadge.tsx     NEW — presentational: online/offline + ready dot
  InstallPrompt.tsx    NEW — beforeinstallprompt capture + iOS instructions

/hooks
  useParagraphPlayer.ts  + currentParagraph, currentIndex outputs
  useOnline.ts         NEW — navigator.onLine + event subscription
```

- The **library** is a container route: it fetches `getAllBooks()` and renders `LibraryList` (presentational). Upload is available from the library (reuse `UploadButton`) so a new book lands and immediately appears in the grid.
- The **reader** stays the playback container. It reads `:bookId` from the URL, loads `getBook` + `getChaptersByBook`, seeds the player pointer from `Book.position` (resume), and writes progress back on a debounce. Playback state remains container-local — **never Context**.
- The **player hook** only adds two read-only outputs derived from `pointerRef`; no new side effect. The resume seed is passed in as a new optional arg `initialIndex?` so the hook remains pure w.r.t. its args and the container controls when to apply it (mount only).
- **Offline** is a config fix (Workbox) + a Settings subsection (voice management, already-backed by the TTS client) + a small `useOnline` hook + `OfflineBadge`. No new persistence.
- **PWA polish** is `index.html` link tags + generated icon assets + an `InstallPrompt` component listening to `beforeinstallprompt`. No core-logic change.

## Commands

Unchanged from M4 — run at the workspace root:

```
pnpm install              # install deps (no additions in M5)
pnpm dev                  # Vite dev server (web/)
pnpm build                # production build → web/dist
pnpm preview              # serve built dist (use this + hard reload to verify SW)
pnpm typecheck            # tsc --noEmit
pnpm lint                 | biome check (spike/ excluded)
pnpm lint:fix             # biome check --write
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build (run before commits)
pnpm -C web scripts:icons # regenerate icons (gen-icons.mjs) — if added as a script
```

## Project structure (addions under `web/`)

```
src/types.ts               + BookPosition; Book.position?, Book.progressFraction?
src/lib/db.ts              + getAllBooks, deleteBookCascade, updateBookProgress
src/lib/db.test.ts         + new helpers, cascade-delete isolation, progress round-trip
src/routes/library.tsx   NEW — container: fetch + upload + delete
src/routes/library.test.tsx  NEW
src/components/BookCover.tsx   NEW — presentational
src/components/BookCard.tsx    NEW — presentational
src/components/LibraryList.tsx NEW — presentational (grid + empty state)
src/components/BookCover.test.tsx  NEW
src/hooks/useOnline.ts    NEW — navigator.onLine + event subscription
src/hooks/useOnline.test.ts  NEW
src/components/OfflineBadge.tsx NEW — presentational
src/components/InstallPrompt.tsx NEW — beforeinstallprompt + iOS instructions
src/routes/settings.tsx     + "Voices & offline" subsection + InstallPrompt mount
src/routes/settings.test.tsx + voice states (stub TtsEngine), install prompt
src/hooks/useParagraphPlayer.ts + currentParagraph, currentIndex, initialIndex arg
src/hooks/useParagraphPlayer.test.ts + new outputs + initialIndex seeding
src/routes/reader.tsx       /reader/:bookId; resume; debounced progress writes
src/routes/reader.test.tsx  + param load, resume, 404 → library, progress write
src/routes/landing.tsx      + library CTA + continue-reading shortcut
src/components/Nav.tsx      + Library link
src/App.tsx                 + /library route, /reader/:bookId, /reader redirect
index.html                  + apple-touch-icon, apple-touch-startup-image links
scripts/gen-icons.mjs       + apple-touch-icon (180), iOS splash sizes
public/icons/               + apple-touch-icon-180.png, apple-splash-*.png
vite.config.ts              Workbox globPatterns += wasm,data (or runtime cache)
```

## Code style

Follows `.opencode/tech/typescript/patterns.md` + `react/patterns.md` and the M0–M4 conventions. Highlights:

- **Strict TS**, branded IDs, `import type` for type-only imports (`verbatimModuleSyntax`)
- **Container/presentational split** — `library.tsx` + `reader.tsx` are containers (own data + state); `BookCover`/`BookCard`/`LibraryList`/`OfflineBadge` are props-only
- **Context for low-frequency state only** (settings) — library list, progress, online status, install prompt are all container/component-local; **never** in Context
- **Variant types** for async/machine states (`{ type: 'loading' } | { type: 'ready'; books } | { type: 'error' }`)
- **Define the contract before implementing** — `BookPosition`, db helper signatures, player outputs before bodies
- **Additive storage** — new `Book` fields are optional; no migration, no `DB_VERSION` bump
- No comments unless asked; Biome handles format/import-order (2-space, single quotes, no semicolons, trailing commas)

## Testing strategy

- **DB** (`lib/db.test.ts`, extended): `getAllBooks` returns newest-first; `deleteBookCascade` removes the book + its chapters + its file and leaves other books untouched; `updateBookProgress` round-trips `position`/`progressFraction` and bumps `updatedAt`; an existing book record lacking the new fields loads with them `undefined` (no throw).
- **Player hook** (`hooks/useParagraphPlayer.test.ts`, extended): `currentParagraph`/`currentIndex` track the pointer through play/advance/seek; `initialIndex` seeds the pointer without a play (so resume can compute fraction before first play).
- **Library** (`routes/library.test.tsx`, new): renders `LibraryList` with two books (titles, formats, progress bars); empty state when none; Open navigates to `/reader/:bookId`; Delete (with confirm) removes the card. `BookCover` renders expected initials.
- **Reader** (`routes/reader.test.tsx`, extended): `/reader/:bookId` loads the right book; a saved `position` seeds playback on mount (assert via stub player or `currentParagraphId`); an unknown id redirects to `/library`; progress write fires (debounced) on advance and on unmount.
- **Settings** (`routes/settings.test.tsx`, extended): "Voices & offline" lists the catalog; a stub `TtsEngine` reports `isStored` → row shows ✓; Download → progress then ✓; Remove → cleared. Install prompt renders when a synthetic `beforeinstallprompt` event fires.
- **`useOnline`** (`hooks/useOnline.test.ts`, new): flips on `offline`/`online` events.
- **Browser** (chrome-devtools MCP): upload 2 books → library shows both with generated covers → open one → play 3 paragraphs → reload → resume at saved position → library progress bar updated → toggle DevTools network Offline → reload → app shell loads + stored voice still synthesizes → install prompt visible → delete a book → returns to library. **Zero console errors; zero cdnjs calls** (wasm served locally).
- **Coverage target:** new db helpers + `useOnline` + `BookCover` >90%; library/reader/settings wiring smoke-tested.

## Boundaries

- **Always:** `pnpm typecheck && pnpm test && pnpm lint` green before considering a task done; define interfaces (`BookPosition`, db helper signatures, player outputs) before implementing; keep presentational components props-only; verify SW/offline via `pnpm preview` + hard reload (not `pnpm dev`).
- **Ask first:** adding dependencies; bumping `DB_VERSION` or changing object-store list (M5 should need neither); changing the SW precache strategy beyond adding wasm/data; removing the ORT 1.18.0 pin.
- **Never:** disable strict TS; put library/progress/playback state in Context; depend on a CDN at runtime (the Workbox fix is specifically to remove the offline gap); delete a failing test to make CI pass; mutate a book record's identity fields (`id`/`createdAt`).

## Success criteria (testable)

1. After uploading two books, both appear in `/library` with generated covers, titles, formats, and progress bars.
2. Opening a book from the library deep-links to `/reader/:bookId` and shows that book's content (not the most-recent).
3. Playing into a book, then reloading, resumes playback at the same paragraph (±1 if cleaning drifted).
4. The library progress bar reflects reading progress after a reading session.
5. Deleting a book removes it from the library and cascades to its chapters + uploaded file.
6. In Settings → "Voices & offline", a voice can be downloaded (with progress) and shows ✓; it persists across reloads; it can be removed.
7. With DevTools network Offline, the app shell still loads and a stored voice still synthesizes (no network, no cdnjs).
8. The offline badge correctly reflects online/offline state in real time.
9. `apple-touch-icon` is present; an install prompt is offered on Chromium; iOS shows install instructions.
10. `pnpm verify` (lint + typecheck + test + build) is green.
11. chrome-devtools MCP run: **zero console errors**; **zero cdnjs network requests**; library + resume + offline verified.

## Risks (tracked, not blocking)

| Risk | Mitigation |
| ---- | ---------- |
| **Workbox precache grows large with wasm/data** | Piper runtime is ~tens of MB. Acceptable for an installable offline-first PWA; if it balloons, switch `/wasm/**` to a runtime cache (`cacheFirst`) instead of precache. Verify build size in T6. |
| **Progress writes spam IDB on every paragraph** | Debounced (≥2s between writes) + final write on pause/stop/unmount. Each write is a single `put` on the `books` store — cheap. |
| **Resume lands on the wrong paragraph after a cleaning-config change** | Position is matched against the *cleaned* stream by `chapterId:paragraphIndex`; on miss, fall back to clamped flat index → `{0,0}`. Acceptable; documented. |
| **`/reader/:bookId` deep links to a deleted book** | `getBook` returns `undefined` → redirect to `/library`. Tested. |
| **iOS `beforeinstallprompt` never fires** | Feature-detect; show manual "Share → Add to Home Screen" instructions on iOS instead. No crash on non-supporting browsers. |
| **iOS splash image set is large/tedious** | Ship a minimal latest-iPhone set; extend later. Trailing task (T5) that can defer without blocking core library/resume value. |
| **Service worker caches stale M5 bundle** | Existing gotcha #3: verify via `pnpm preview` + hard reload, or unregister the SW. |
| **iOS ITP evicts OPFS models after 7 days** | Existing gotcha #2: models are re-downloadable; original `BookFile` is the source of truth. `navigator.storage.persist()` already requested in `main.tsx`. |
| **Real-iPhone background-playback gate still open (gotcha #5)** | Unchanged from M3/M4 — M5 does not touch playback. PWA polish is best confirmed on real iOS too, but does not block `pnpm verify`. |

## Tasks (ordered, dependency-chained)

| # | Task | Acceptance | Verify | Files |
| - | ---- | ---------- | ------ | ----- |
| T1 | Data model + db helpers | `BookPosition` + optional `Book` fields; `getAllBooks`/`deleteBookCascade`/`updateBookProgress`; existing books load without the new fields | `lib/db.test.ts` (extended) | `types.ts`, `lib/db.ts`, `lib/db.test.ts` |
| T2 | Library route + generated covers | `/library` lists books (cards + generated covers + progress); Open/Delete; empty state; nav + Home CTA wired | `routes/library.test.tsx`, `components/BookCover.test.tsx` | `routes/library.tsx`, `components/{BookCover,BookCard,LibraryList}.tsx`, `App.tsx`, `components/Nav.tsx`, `routes/landing.tsx`, tests |
| T3 | Reader routing + resume + progress | `/reader/:bookId`; resume from `Book.position`; `currentParagraph`/`currentIndex` on the player; debounced progress writes; bare `/reader` redirect | `routes/reader.test.tsx`, `hooks/useParagraphPlayer.test.ts` | `routes/reader.tsx`, `hooks/useParagraphPlayer.ts`, `App.tsx`, tests |
| T4 | Offline + voice management | Workbox caches wasm/data; Settings "Voices & offline" (download/remove/✓); `useOnline` + `OfflineBadge` | `routes/settings.test.tsx`, `hooks/useOnline.test.ts`; browser offline check in T6 | `vite.config.ts`, `routes/settings.tsx`, `hooks/useOnline.ts`, `components/OfflineBadge.tsx`, tests |
| T5 | PWA polish | apple-touch-icon + iOS splash links; `InstallPrompt` (beforeinstallprompt + iOS instructions); standalone behavior | browser MCP + manual iOS note | `index.html`, `scripts/gen-icons.mjs`, `public/icons/`, `components/InstallPrompt.tsx` |
| T6 | E2E + browser verify | Library + resume + offline + install verified; zero console errors; zero cdnjs; `pnpm verify` green | full `pnpm verify` + chrome-devtools MCP | wiring + minor fixes |

**Ordering:** T1 → T2 → T3 → (T4 ‖ T5) → T6. T4 and T5 are independent of each other and may be parallelized.

**Checkpoints:** A (T1: data model + helpers) · B (T2: library shipped) · C (T3: resume works end-to-end) · D (T4: offline verified) · E (T5: PWA polished) · F (T6: M5 shipped, verify green).

## Out of scope (later passes)

Author metadata extraction (requires threading `author` through `ParseResult` + each parser); EPUB/MOBI cover-image extraction and storage; collections/tags/sorting options in the library; per-book cleaning-config overrides; sync across devices (cloud is a non-goal per `VISION.md`); a richer install/onboarding flow; sleep timers and bookmarks (future "Reading intelligence" direction).
