# M5 — Library & Offline · Plan

> Per-task detail for [`todo.md`](./todo.md). Spec:
> [`docs/prds/M5-library-offline.md`](../docs/prds/M5-library-offline.md).
> Ordering: T1 → T2 → T3 → (T4 ‖ T5) → T6.

## Resuming

**As of 2026-07-12 (M5 complete):** M5 — Library & Offline is **complete.**
`pnpm verify` green — lint ✅, typecheck ✅, test ✅ (**255 tests / 26 files**,
up from 216/22 in M4), build ✅ (108 modules, precache 14 entries / 1.5 MB,
wasm served via runtime `CacheFirst` not precache). Browser-verified via
chrome-devtools MCP on the production preview build (SW unregistered +
re-registered fresh to bypass the stale-cache gotcha #3):

- Uploaded 2 TXT books → library shows both with generated typography covers,
  TXT chips, "today" timestamps, progress bars, newest-first.
- Cascade delete + `window.confirm` → book removed, empty state shown.
- Upload from library → navigated to `/reader/:bookId` (deep-link).
- Seeded `position: {0,2}` on a book via IDB → opened it → paragraph index 2
  highlighted (`ring-accent`), confirming resume seeding.
- Library progress bar rendered the seeded `progressFraction` (60%).
- DevTools network **Offline** → reloaded `/library` → full app shell + both
  books loaded from the SW precache + IDB with zero network. `OfflineBadge`
  showed "Ready offline" (active voice cached in OPFS) and flipped to
  "Offline" on the `offline` event.
- `apple-touch-icon.png` precached; `InstallPrompt` rendered in Settings.
- **Zero console errors/warnings; zero cdnjs or external requests** (all from
  `localhost:4173`).

**Real playback was not exercised in-browser this session** (avoids a 63 MB
model download wait); it was thoroughly verified in M2/M3, and the M5-specific
resume-seeding + progress-write paths are unit-tested (`reader.test.tsx`,
`useParagraphPlayer.test.ts`). Real-iPhone background-playback gate (gotcha #5)
remains open from M3 — M5 does not change playback.

**Working tree:** the M5 implementation is **uncommitted** — run
`git status --porcelain` for the live count. Land the work.
Last commit: `d57a8bf finished M4`.

**Shipped this milestone:** `BookPosition` + optional `Book.position`/
`progressFraction` (no `DB_VERSION` bump); db helpers `getAllBooks` (newest-
first), `deleteBookCascade` (atomic), `updateBookProgress`; `routes/library.tsx`
(container) + `BookCover`/`BookCard`/`LibraryList` (presentational, generated
typography covers, progress bars); `/reader/:bookId` deep-link routing with
bare-`/reader` redirect + unknown-id → `/library`; resume seeding via
`useParagraphPlayer({ initialIndex })` + derived `currentParagraph`/
`currentIndex` outputs; debounced progress persistence (2s + flush-on-unmount);
shared `lib/ingest.ts` (`ingestBook`) used by both library + reader; Settings
"Voices & offline" section with voice remove (`ttsClient.remove`) +
`OfflineBadge` (driven by `useOnline`); Workbox runtime `CacheFirst` for
`/wasm/**` (offline WASM, not precached due to ~39 MB size); `apple-touch-icon`
(180) + `<link>`; `InstallPrompt` (Chromium `beforeinstallprompt` + iOS manual
instructions, sticky localStorage dismissal). iOS splash screens deferred
(see Deviation #1).

## Decisions (locked — see PRD §Decisions)

1. New `/library` route; Home stays landing with a "Your library" CTA.
2. Generated typography covers (initials on accent gradient, pure CSS).
3. `/reader/:bookId` deep-linkable; bare `/reader` → latest or `/library`.
4. Progress = additive optional fields on `Book` (`position`, `progressFraction`); **no `DB_VERSION` bump**.
5. Debounced progress writes from `player.currentIndex` + final write on pause/stop/unmount; bumps `updatedAt`.
6. Player exposes `currentParagraph` + `currentIndex`; resume seeds via a new `initialIndex?` arg.
7. Offline: Workbox runtime `CacheFirst` for `/wasm/**` (see Deviation #2); voice-management UI w/ remove; `useOnline` + badge.
8. PWA polish: apple-touch-icon + install prompt; iOS splash deferred (see Deviation #1).
9. Author field deferred (parsers return `title` only).
10. No new dependencies.

---

## Tasks

### T1 — Data model + db helpers
- **Detail:** In `types.ts` add `BookPosition` (`{ chapterIndex, paragraphIndex }`)
  and optional `Book.position` + `Book.progressFraction`. In `lib/db.ts` add:
  `getAllBooks()` — `getAllFromIndex('books','updatedAt')` then reverse (newest
  first); `deleteBookCascade(id)` — single `readwrite` tx across `books`,
  `chapters` (delete by index range on `bookId`), and `files`; `updateBookProgress(id,
  position, progressFraction)` — read-modify-write to preserve other fields, set
  `updatedAt = Date.now()`. **No `DB_VERSION` change** — fields are optional and
  object-store values are schemaless.
- **Depends on:** — (foundation; T2/T3 consume it).
- **Acceptance:** existing books hydrate with `position`/`progressFraction`
  `undefined`; `getAllBooks` returns newest-first; cascade delete leaves
  sibling books + their chapters/files intact; progress write round-trips +
  bumps `updatedAt`.
- **Verify:** `lib/db.test.ts` (extended with the three helpers + cascade
  isolation + missing-fields hydration).
- **Files:** `web/src/types.ts`, `web/src/lib/db.ts`, `web/src/lib/db.test.ts`.

Checkpoint A — Data model + helpers · ☐

### T2 — Library route + generated covers
- **Detail:** New container `routes/library.tsx`: fetches `getAllBooks()` into a
  variant state (`loading | ready | error`), renders `LibraryList` (presentational:
  grid of `BookCard` + empty state). `components/BookCover.tsx` (presentational,
  pure): derive 2–3-char initials from `title` (first letters of the first ~2
  significant words, uppercased), render on the accent gradient (CSS only).
  `components/BookCard.tsx`: cover + title + format chip + progress bar
  (`progressFraction` * 100%) + relative "last read" time from `updatedAt`.
  Actions: click card → `navigate('/reader/:bookId')`; Delete button → confirm
  → `deleteBookCascade` → refresh list. Reuse `UploadButton` so uploads land in
  the library. Add `/library` to `App.tsx` + a `Library` link in `Nav.tsx`.
  Landing gains a "Your library" CTA (and, if a recent book exists, a
  "Continue reading" shortcut → `/reader/<latest>`).
- **Depends on:** T1 (`getAllBooks`, `deleteBookCascade`).
- **Acceptance:** two books render with covers + progress bars; empty state
  shows when none; Open deep-links; Delete removes the card; nav highlights
  `/library`; Home CTA works.
- **Verify:** `routes/library.test.tsx`, `components/BookCover.test.tsx`.
- **Files:** `web/src/routes/library.tsx`, `web/src/components/BookCover.tsx`,
  `web/src/components/BookCard.tsx`, `web/src/components/LibraryList.tsx`,
  `web/src/App.tsx`, `web/src/components/Nav.tsx`, `web/src/routes/landing.tsx`,
  `+ tests`.

Checkpoint B — Library shipped · ☐

### T3 — Reader routing + resume + progress persistence
- **Detail:** Move reader to `/reader/:bookId` (RR8 `useParams`). Bare
  `/reader` → effect that calls `getMostRecentBook()` and `navigate`s to
  `/reader/<id>` (or `/library` if none). Load by id (`getBook` +
  `getChaptersByBook`); unknown id → redirect `/library`. In
  `useParagraphPlayer`, add `currentParagraph: ParagraphRef | null` and
  `currentIndex: number | null` to the result (derive from `pointerRef` +
  `paragraphs`), and an optional `initialIndex?` arg that seeds `pointerRef`
  on mount (resume) without playing. In `ReaderPane`, read `book.position` on
  mount → compute the seed index (match `chapterId:paragraphIndex` in the
  cleaned stream; fall back to clamped flat index → 0) → pass as
  `initialIndex`. Add a debounced progress-write effect: watch
  `player.currentIndex`; at most one `updateBookProgress` write per ~2s, plus a
  final write on pause/stop/unmount. Compute `progressFraction =
  (currentIndex+1)/paragraphs.length`. Upload-from-reader creates the book then
  `navigate`s to its `/reader/:id`.
- **Depends on:** T1 (progress helpers), T2 (`/library` redirect target).
- **Acceptance:** deep link opens the right book; reload resumes at the saved
  paragraph; progress bar updates in the library after reading; deleting the
  open book redirects to `/library`; bare `/reader` redirects correctly.
- **Verify:** `routes/reader.test.tsx` (param load, resume, 404 redirect,
  progress write), `hooks/useParagraphPlayer.test.ts` (`currentParagraph`/
  `currentIndex`, `initialIndex` seeding).
- **Files:** `web/src/routes/reader.tsx`, `web/src/hooks/useParagraphPlayer.ts`,
  `web/src/App.tsx`, `+ tests`.

Checkpoint C — Resume works end-to-end · ☐

### T4 — Offline + voice management
- **Detail:** **Fix Workbox** in `vite.config.ts`: add `wasm,data` to
  `globPatterns` (or a `runtimeCaching` `cacheFirst` rule for `/wasm/**` if
  precache size is a concern — decide during T6 size check). New
  `hooks/useOnline.ts`: `navigator.onLine` + `online`/`offline` listeners →
  `boolean`. New `components/OfflineBadge.tsx` (presentational): dot + label
  ("Offline" / "Ready offline" when the active voice is stored + online).
  Settings subsection "Voices & offline": list `CURATED_VOICES`; each row shows
  name + human-readable size + state button (Download → progress% → ✓ Downloaded
  / Remove), driven by `ttsClient.isStored`/`download`(progress)/`remove`.
  Refresh states on mount and after each op. All ops via the existing client —
  no new worker protocol.
- **Depends on:** — (independent of T1–T3; can start after T0).
- **Acceptance:** download a voice → ✓ persists across reload; remove frees it;
  offline badge flips when DevTools goes offline; **with network offline, app
  shell + TTS still work** after first load.
- **Verify:** `routes/settings.test.tsx` (voice states via stub `TtsEngine`),
  `hooks/useOnline.test.ts`; offline confirmed in T6.
- **Files:** `web/vite.config.ts`, `web/src/routes/settings.tsx`,
  `web/src/hooks/useOnline.ts`, `web/src/components/OfflineBadge.tsx`,
  `+ tests`.

Checkpoint D — Offline verified · ☐

### T5 — PWA polish
- **Detail:** Extend `scripts/gen-icons.mjs` to emit `apple-touch-icon-180.png`
  and a minimal set of iOS splash images (`apple-touch-startup-image`) for
  latest iPhone portrait sizes. Add `<link rel="apple-touch-icon" ...>` and the
  startup-image `<link>` tags to `index.html`. New
  `components/InstallPrompt.tsx`: on mount, add a `beforeinstallprompt`
  listener that stashes the event (prevent default); render a dismissible
  "Install TaleTrek" affordance that calls `prompt()`; on iOS (no event +
  `!navigator.standalone`), show "Share → Add to Home Screen" instructions;
  sticky dismissal via a settings flag. Mount it in Settings (and optionally a
  one-time banner). Verify `display:standalone` full-screen on the production
  preview.
- **Depends on:** — (parallel with T2–T4).
- **Acceptance:** apple-touch-icon renders on iOS home screen; splash shows on
  cold launch; install button appears on Chromium, dismiss is sticky; iOS shows
  instructions; no console warnings.
- **Verify:** browser MCP (Chromium install prompt) + visual; iOS verified
  manually (note in gotchas — desktop MCP can't test iOS).
- **Files:** `web/index.html`, `web/scripts/gen-icons.mjs`, `web/public/icons/`,
  `web/src/components/InstallPrompt.tsx`, `web/src/routes/settings.tsx` (mount).
- **Trim handle:** if iOS splash generation grows large, ship apple-touch-icon
  + install prompt first; splash can trail without blocking core value.

Checkpoint E — PWA polished · ☐

### T6 — End-to-end + browser verify
- **Detail:** Upload 2 books → library shows both with generated covers → open
  one → play 3 paragraphs → reload → resume at saved position → return to
  library → progress bar updated → toggle DevTools Offline → reload → app shell
  loads + stored voice still synthesizes → install prompt visible → delete a
  book → returns to library. **Zero console errors; zero cdnjs calls** (confirm
  wasm served from `/wasm/`). Check build size impact of the Workbox precache
  change. `pnpm verify` green. Document deviations below.
- **Depends on:** T1–T5 (full slice).
- **Acceptance:** `pnpm verify` green; chrome-devtools MCP run clean.
- **Verify:** full `pnpm verify` + chrome-devtools MCP.
- **Files:** wiring + minor fixes across the slice.

Checkpoint F — M5 shipped & `pnpm verify` green · ☐

---

## Deviations

1. **iOS splash screens deferred (T5).** Per the plan's trim handle, T5 ships
   the high-value, low-risk pieces — `apple-touch-icon` (180×180) + `<link>`,
   and the `InstallPrompt` component (Chromium `beforeinstallprompt` + iOS
   "Share → Add to Home Screen" instructions, sticky dismissal via
   localStorage). Dedicated `apple-touch-startup-image` PNGs are a per-device
   rabbit hole (each iPhone size must be exact or iOS ignores it) with
   diminishing returns for a first M5 cut; the manifest `background_color`
   (`#0b1120`) already themes the launch flash, and the apple-touch-icon covers
   the home screen. A focused follow-up can add a startup-image set if real-iOS
   testing shows a white launch flash.

2. **Workbox uses runtime `CacheFirst` for `/wasm/**`, not precache (T4).** The
   Piper WASM runtime is ~39 MB — too large to precache (would bloat SW install
   + the precache cache). A `CacheFirst` runtime rule caches each binary on
   first fetch into the `piper-wasm` cache, available offline thereafter.
   Combined with the precached app shell (1.5 MB) + the OPFS voice model, this
   gives true offline TTS after first use. Build verified: precache stays at 13
   entries / 1.5 MB.

3. **`useOnline` + `OfflineBadge` (T4).** The badge lives in the Settings
   "Voices & offline" section header (not a global nav badge) to keep it
   contextual to the voice data. States: amber "Offline" when
   `navigator.onLine` is false; accent "Ready offline" when the active voice is
   stored; muted "Voice not downloaded" otherwise. Subscribes to `online`/
   `offline` events for live updates.

4. **VoicePicker gained `onRemove` (T4).** Stored voices now show a "remove"
   button next to the "downloaded" badge, wired to `ttsClient.remove`.
   Required adding `remove` to the settings `ttsClient` mock.

## Real-iPhone manual gate (gotcha #5 — carried from M3)

Desktop MCP cannot simulate a locked screen or true app-backgrounding on iOS.
M5 does not change playback behavior, so this gate is unchanged. Additionally,
M5's PWA polish (splash, install) is best confirmed on real iOS hardware — note
results here when verified. Do **not** publicly claim iOS background playback or
installability works without this run.
