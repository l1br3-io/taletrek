# M4 — Clean Reading · Plan

> Per-task detail for [`todo.md`](./todo.md). Spec:
> [`docs/prds/M4-clean-reading.md`](../docs/prds/M4-clean-reading.md).
> Ordering: T1 → T2 → T3 → T4 → T5.

## Resuming

**As of 2026-07-12 (M4 complete):** M4 — Clean Reading is **complete.**
`pnpm verify` green — lint ✅, typecheck ✅, test ✅ (**216 tests / 22 files**,
up from 161/19 in M3), build ✅ (100 modules, up from 97, PWA generated).
Browser-verified via chrome-devtools MCP on the production preview build:
uploaded a 6-paragraph TXT with URLs, `[1]`/`[12]` footnote markers, and
standalone `42`/`page 7` page-number lines → display showed exactly 4 cleaned
paragraphs (footnotes stripped, URL stripped, page-number paragraphs dropped,
clean paragraph untouched). Navigated to Settings → toggled the URLs filter off
+ added a `hero`→`HERO` pronunciation entry → returned to Reader → display now
showed `https://example.com` (URL filter off) AND "The HERO walked into the
tavern." (pronunciation applied, case-insensitive whole-word). All four
remaining filters stayed active. Zero console errors, zero cdnjs calls.

**Working tree:** the M4 implementation is **uncommitted** — run
`git status --porcelain` for the live count. Land the work before starting M5.
Last commit: `e977801 finish M3`.

**Shipped this milestone:** pure `lib/clean/` module (`types.ts`, `filters.ts`
with `stripUrls`/`stripImages`/`stripFootnoteRefs`/`isPageNumberLine`/
`cleanText`, `pronunciation.ts` with `applyPronunciation` regex-escaped
whole-word case-insensitive, `index.ts` with `cleanParagraphs`/`cleanChapters`
dropping empties + `enabled:false` passthrough); `CleaningConfig` on `Settings`
+ `DEFAULT_CLEANING` (additive — zero migration, no `DB_VERSION` bump);
`reader.tsx` derives `cleanedChapters` via `useMemo` → both player + ReaderView;
`useParagraphPlayer` invalidates the queue on paragraphs-reference change;
settings UI with master toggle + four filter rows + pronunciation editor
(add/edit/delete, `crypto.randomUUID` keys).

**Real-iPhone background-playback gate (gotcha #5) is still OPEN** from M3 —
desktop MCP verified tab-backgrounding + Media Session wiring, but a
locked-screen run on real iOS hardware is required before claiming background
playback works. Unchanged by M4 (M4 does not touch playback behavior).

---

## Tasks

### T1 — Cleaning module (`lib/clean/`)
- **Detail:** Create a pure, side-effect-free module (no React/IDB/DOM) under
  `web/src/lib/clean/`. `types.ts` holds `CleaningFilters`,
  `PronunciationEntry`, `CleaningConfig`. `filters.ts` holds four pure
  `string → string` (or predicate) functions: (a) `stripUrls` — drop bare
  `https?://\S+` and `www\.\S+`, rewrite markdown `[text](url)` → keep `text`;
  (b) `stripImages` — drop `![alt](url)` entirely, drop `[Image: …]` /
  `[Figure: …]` markers; (c) `stripFootnoteRefs` — drop inline `[\d{1,3}]`,
  drop `[n]:` definitions, drop superscript unicode digits `¹²³`; **do not**
  match `(\d+)` (catches years like `(1984)`); (d) `isPageNumberLine` —
  predicate true when the *whole* paragraph is `^\s*\d{1,4}\s*$` or
  `^\s*page\s+\d+\s*$` (case-insensitive). `pronunciation.ts` holds
  `applyPronunciation(text, entries)`: build a single alternation regex from
  the `find` strings, **each regex-escaped**, matched whole-word
  (`\bescaped\b`) and case-insensitive; empty `find` entries skipped; first
  match wins per position; replace via the corresponding `replace`. `index.ts`
  composes: `cleanText(text, filters)` runs the active structural filters in
  order; `cleanParagraphs(paragraphs, config)` returns `config.enabled ?
  paragraphs.map(p => applyPronunciation(cleanText(p, config.filters),
  config.pronunciation)).filter(nonEmpty) : paragraphs` (returns the **same
  reference** when disabled); `cleanChapters(chapters, config)` maps over
  chapters, preserving `title`/`index`/`id` and rewriting only `paragraphs`.
  Page-number filter drops the whole paragraph (via `isPageNumberLine`)
  *before* the structural-in-paragraph filters run on the survivors.
- **Depends on:** — (foundation; T2/T3 consume it).
- **Acceptance:** all four filters transform representative strings correctly
  (incl. the `(1984)` negative); markdown link keeps its text; pronunciation is
  whole-word + case-insensitive + regex-escaped (`C++` doesn't crash); empties
  dropped; `enabled:false` returns the input reference unchanged; `cleanChapters`
  preserves all chapter fields except `paragraphs`.
- **Verify:** `lib/clean/{filters,pronunciation,index}.test.ts`.
- **Files:** `web/src/lib/clean/types.ts`, `filters.ts`, `pronunciation.ts`,
  `index.ts`, `filters.test.ts`, `pronunciation.test.ts`, `index.test.ts`.

Checkpoint A — Cleaning module pure + tested · ☐

### T2 — Settings additions
- **Detail:** Add `CleaningConfig` (imported from `lib/clean/types`) to the
  `Settings` interface in `context/settings.tsx`. Add a `cleaning` field to
  `DEFAULT_SETTINGS`: `{ enabled: true, filters: { urls: true, images: true,
  footnotes: true, pageNumbers: true }, pronunciation: [] }`. The existing
  spread-merge hydration (`{ ...DEFAULT_SETTINGS, ...stored }`) fills the new
  field for existing users automatically — **no migration code, no
  `DB_VERSION` bump**. No other changes to the provider.
- **Depends on:** T1 (for the `CleaningConfig` type).
- **Acceptance:** a stored `Settings` record lacking `cleaning` hydrates with
  the full default; `useSetting('cleaning')` returns the tuple; a round-trip
  (`update({cleaning: x})` → reload → read) preserves the value.
- **Verify:** extend `context/settings` coverage or assert via `getSetting('app')`
  in a settings test.
- **Files:** `web/src/context/settings.tsx`.

### T3 — Wire cleaning into reader + player invalidation
- **Detail:** In `routes/reader.tsx`, derive `cleanedChapters` via `useMemo`
  keyed on `[load.chapters, settings.cleaning]`: when
  `settings.cleaning.enabled`, call `cleanChapters(load.chapters,
  settings.cleaning)`; otherwise return `load.chapters` unchanged. Pass
  `cleanedChapters` (not `load.chapters`) to **both** `useParagraphPlayer` and
  `ReaderView`. In `hooks/useParagraphPlayer.ts`, add an effect (or extend the
  existing generation-token mechanism) that detects a **reference change** to
  the `chapters` argument: on change, bump the generation token, revoke all
  queued Blob URLs, clear the queue, and re-prime from the current paragraph
  index. This mirrors the existing voice-change invalidation. Preserve the
  current playback position (chapterIndex + paragraphIndex) across the
  re-prime. Guard: if the hook is idle (not yet played), just re-flatten.
- **Depends on:** T1 (module), T2 (settings).
- **Acceptance:** rendered reader text and synthesized text are identical and
  both reflect cleaning; a URL/noise paragraph is absent from display + audio;
  toggling a filter mid-playback invalidates the queue and re-primes within one
  synth cycle; `seekToParagraph` still lands on the right paragraph (ids are
  consistent within the cleaned array).
- **Verify:** `routes/reader.test.tsx` (cleaned-text assertion + synth `calls`),
  `hooks/useParagraphPlayer.test.ts` (chapters-change → queue invalidated).
- **Files:** `web/src/routes/reader.tsx`, `web/src/hooks/useParagraphPlayer.ts`,
  `routes/reader.test.tsx`, `hooks/useParagraphPlayer.test.ts`.

Checkpoint B — Wired: display + audio reflect cleaning; mid-playback toggle re-primes · ☐

### T4 — Settings UI
- **Detail:** Add a cleaning section to `routes/settings.tsx` (props-only UI;
  reads via `useSetting('cleaning')`). Three parts: (a) a master `enabled`
  toggle (card-button with `aria-pressed`, mirroring the theme toggle pattern);
  (b) four filter toggle rows (denser list, each an `aria-pressed` button or
  checkbox-style row for `urls`/`images`/`footnotes`/`pageNumbers`); (c) a
  pronunciation-dictionary editor — a list of entries each with `find` + input,
  `replace` + input, and a delete button, plus an "Add entry" button that
  appends `{ id: crypto.randomUUID(), find: '', replace: '' }`. All writes go
  through `update({ cleaning: { ...cleaning, filters: {…} } })` (shallow nested
  merge — the provider's `update` is a one-level spread, so the settings UI must
  spread the nested objects explicitly). The section is disabled/hidden when
  the master toggle is off (except the master toggle itself). Empty `find`
  entries are allowed in the UI (the cleaning module skips them at apply time).
- **Depends on:** T2 (settings field).
- **Acceptance:** master toggle persists across reload; each filter toggle
  persists; add/edit/delete a pronunciation entry round-trips through IDB;
  the UI is presentational (no direct IDB calls — all via `useSetting`).
- **Verify:** `routes/settings.test.tsx` (extended).
- **Files:** `web/src/routes/settings.tsx`, `web/src/routes/settings.test.tsx`.

Checkpoint C — Settings UI complete · ☐

### T5 — End-to-end + browser verify
- **Detail:** Upload a TXT containing URLs, `[1]`-style markers, and standalone
  page-number lines → confirm the reader omits them and the synthesized audio
  omits them (assert via stub engine or MCP audio check). Toggle `urls` off
  mid-playback → the queue invalidates and re-primes, URL reappears. Add a
  pronunciation entry `{find: 'foo', replace: 'bar'}` → the spoken/displayed
  text changes. Add a regex-special `find` (`C++`) → no crash. Zero console
  errors; zero cdnjs calls; `pnpm verify` green. Document any deviations below.
- **Depends on:** T1–T4 (full slice).
- **Acceptance:** `pnpm verify` green; chrome-devtools MCP run clean.
- **Verify:** full `pnpm verify` + chrome-devtools MCP.
- **Files:** wiring + minor fixes across the slice.

Checkpoint D — Clean Reading shipped & `pnpm verify` green · ☐

---

## Deviations

1. **Filter execution order is images → urls → footnotes (not urls → images).**
   The PRD listed filters as urls/images/footnotes conceptually, but
   `cleanText` runs `stripImages` before `stripUrls` because the `stripUrls`
   markdown-link regex (`[text](url)`) would otherwise match the `[img](url)`
   portion of a markdown image `![img](url)`, leaving a stray `!img`. Running
   images first removes the full image syntax cleanly. No behavior difference
   for the user; just internal ordering. Caught by the T1 unit tests.

2. **Settings test hydration pattern (`renderHydrated` helper).** The
   SettingsProvider's async hydration (`getSetting().then(setSettings)`) can
   overwrite an optimistic UI update if a test clicks before hydration
   resolves. The existing theme test solved this by pre-seeding a value and
   using `findByRole({pressed: ...})` to wait. The cleaning tests adopt the
   same pattern via a `renderHydrated()` helper that pre-seeds
   `{fontScale: 1.25}` as a sentinel and waits for the `×1.25` marker (which
   only appears post-hydration) before interacting. Also added
   `_clearDBForTests()` to the settings `beforeEach` for test isolation. No
   production impact — in real usage hydration completes in milliseconds.

3. **`prevParagraphsRef` invalidation in `useParagraphPlayer` (T3).** The PRD
   described chapters-change invalidation abstractly; the implementation keys
   on the `paragraphs` memo reference (which changes when `chapters` changes),
   mirroring the existing voice-change effect exactly (`genRef++`,
   `queueRef.clear()`, `syncBufferedAhead()`). No playback interruption — the
   current paragraph finishes; the next advance re-synthesizes with the new
   cleaning config. The "brief re-synth" is the cleared buffer re-filling on
   advance, same class as a voice change.

## Real-iPhone manual gate (gotcha #5 — carried from M3)

Desktop MCP cannot simulate a locked screen or true app-backgrounding on iOS.
Before the read-aloud core is considered "done" for the product's core promise,
verify on a real iPhone (installed to home screen, standalone mode):

1. Start playback → lock the screen → audio continues.
2. Lock-screen controls render (▶/⏸, ⏮/⏭ chapter skip, ±15s, seekbar).
3. Switch to another app → audio continues.
4. Background the browser fully → audio continues for ≥30s.
5. Re-open → playback state is intact.

M4 does not change playback behavior, so this gate is unchanged from M3. Do
**not** publicly claim iOS background playback works without this run.
