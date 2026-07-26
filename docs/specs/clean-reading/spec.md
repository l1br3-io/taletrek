---
status: shipped
started: 2026-07-12
shipped: 2026-07-12
---

# PRD: M4 — Clean Reading

> **Status:** Ready to implement.
> **Companions:** [`../../VISION.md`](../VISION.md), [`../../ROADMAP.md`](../ROADMAP.md), [`M0-foundation.md`](M0-foundation.md), [`M1-upload-read.md`](M1-upload-read.md), [`M2-speak.md`](M2-speak.md), [`M3-jog.md`](M3-jog.md), [`../adrs/0002-mit-piper-pipeline.md`](../adrs/0002-mit-piper-pipeline.md).

## Objective

Ensure only the story reaches the listener's ears. Before text reaches the reader view or the TTS engine, it passes through a **configurable cleaning pipeline** that strips URLs and hyperlinks, image markers and alt-text, footnote references, and standalone page-number lines. A **pronunciation dictionary** lets readers correct how specific words or names are spoken. Filters are toggleable — everything on by default, or fine-tune what stays.

M4 cleans what the reader **sees** and what the TTS **hears** from the same derived view, so the two never diverge. The stored `Chapter.paragraphs` remain the raw source of truth; cleaning is a pure, derived transform applied in the container.

**User story:** *As a listener, I press play and the story flows without the narrator reading out "h-t-t-p-colon-slash-slash" or "[see figure 12]". I can teach TaleTrek how to say a character's name. What I read on screen matches what I hear.*

This milestone is a **pure text-transform layer** on top of M1's parse output and M3's playback engine. It changes **no playback, parsing, or storage behavior** — it adds a derivation step between the stored chapters and the consumers (reader view + player hook).

## Decisions (locked)

| Area | Decision |
| ---- | -------- |
| Clean scope | **Both display + audio.** `reader.tsx` derives `cleanedChapters` via `useMemo` from `load.chapters` + `settings.cleaning`; passes the same array to `useParagraphPlayer` **and** `ReaderView`. What you read = what you hear. |
| Source of truth | Stored `Chapter.paragraphs` stays **raw** — cleaning is a derived view, never persisted back. The original upload (`BookFile`) and parsed chapters are untouched. |
| Insertion point | **Flatten-time** (container-side `useMemo`), not parse-time. Reacts to live setting toggles without re-parsing; no worker-protocol change; no re-clean-on-upload flow. |
| Heuristic ambition | **Conservative.** Ship the filters that work reliably with low false-positive risk: URLs, markdown image markers, scholarly footnote ref markers (`[n]`), standalone page-number paragraphs. Defer book-level repetition detection (headers/footers) and PDF coordinate-based detection to a later pass. |
| Pronunciation dictionary | **Simple `{find, replace}` list**, case-insensitive whole-word substitution. Regex-special chars in `find` are escaped. Applied last (after structural filters). |
| Filter defaults | **All filters on, master `enabled: true`** ("skip everything by default" per the roadmap). Users opt *out* of specific filters. |
| Empty paragraphs | **Dropped** by `cleanChapters` when a paragraph becomes empty after cleaning. Both display and player consume the same dropped array, so `ParagraphRef.id` indices stay consistent within the cleaned view — `seekToParagraph` still matches. |
| Settings storage | **Additive** — new `cleaning: CleaningConfig` field on `Settings` + `DEFAULT_SETTINGS`. The existing spread-merge hydration (`{...DEFAULT_SETTINGS, ...stored}`) fills defaults for existing users. **Zero migration code, no `DB_VERSION` bump.** |
| Mid-playback toggle | Cleaning-config change → `cleanedChapters` recomputes → `useParagraphPlayer` detects the new chapters reference → **invalidates the queue** (revoke stale blobs, bump generation token, re-prime from current position). Mirrors the existing voice-change invalidation (M2). The current paragraph may briefly re-synth (its text changed) — acceptable, same behavior class as a voice change. |
| Empty-chapter edge | If cleaning empties an entire chapter, `flattenParagraphs` yields zero `ParagraphRef`s for it; `nextChapter`/`prevChapter` skip over it. Documented; no special UI. |
| Licensing | ADR-0002 (MIT pipeline) unchanged; no new dependencies. |

## Technologies (additions to M0/M1/M2/M3)

| Package | Version | License | Purpose |
| ------- | ------- | ------- | ------- |
| — | — | — | **No new dependencies.** M4 is pure TypeScript string transforms + React `useMemo` + existing settings Context. No new runtime or dev deps. |

Adding dependencies is ask-first per M0 boundaries.

## Domain model (additions)

New structural types live in the cleaning module. No new branded IDs.

```ts
/** Per-filter enable flags. All default to `true`. */
interface CleaningFilters {
  /** Strip `https?://…`, `www.…`, and rewrite markdown `[text](url)` → `text`. */
  urls: boolean
  /** Strip markdown `![alt](url)` and residual `[Image: …]` / `[Figure: …]` markers. */
  images: boolean
  /** Strip inline `[n]` ref markers, `[n]:` definitions, and superscript digits `¹²³`. */
  footnotes: boolean
  /** Drop paragraphs that are entirely a page number (`^\d{1,4}$`, `^page \d+$`). */
  pageNumbers: boolean
}

/** One pronunciation-dictionary entry. `id` is a stable React key (uuid). */
interface PronunciationEntry {
  id: string
  find: string
  replace: string
}

/** Full cleaning configuration — stored under `Settings.cleaning`. */
interface CleaningConfig {
  /** Master toggle. When `false`, `cleanChapters` returns input unchanged. */
  enabled: boolean
  filters: CleaningFilters
  pronunciation: PronunciationEntry[]
}
```

The cleaning **function contracts** (pure, no React/IDB):

```ts
/** Clean a single paragraph's text given the active filters. */
function cleanText(text: string, filters: CleaningFilters): string

/** Apply the pronunciation dictionary (whole-word, case-insensitive). */
function applyPronunciation(text: string, entries: PronunciationEntry[]): string

/** Clean each paragraph (filters + pronunciation); drop empties. */
function cleanParagraphs(paragraphs: readonly string[], config: CleaningConfig): string[]

/** Clean a list of chapter-shaped objects (preserves title/index/id). */
function cleanChapters<T extends { paragraphs: string[] }>(
  chapters: readonly T[],
  config: CleaningConfig,
): T[]
```

## Architecture

```
SettingsProvider ─────────── settings.cleaning: CleaningConfig (low-freq Context)
                                │ reads
/reader container ──────────────┤  (owns playback state — NEVER Context)
  load.chapters (raw, from IDB) │
    │                           │
    │ useMemo(cleanChapters, [load.chapters, settings.cleaning])
    ▼                           │
  cleanedChapters ──────────────┼──► useParagraphPlayer(cleanedChapters, …)
    │  (drops empty paragraphs; │       + invalidate-on-chapters-reference-change
    │   same array to both)     │          (bump gen token, revoke queue, re-prime)
    │                           │
    └───────────────────────────┴──► ReaderView(cleanedChapters, …)
                                         display shows cleaned text

lib/clean/  (pure, no React/IDB — fully unit-testable)
  types.ts          CleaningFilters, PronunciationEntry, CleaningConfig
  filters.ts        stripUrls, stripImages, stripFootnoteRefs, isPageNumberLine
  pronunciation.ts  applyPronunciation (regex-escaped, whole-word, case-insensitive)
  index.ts          cleanText, cleanParagraphs, cleanChapters
```

- The `/reader` route remains the **container**. It derives `cleanedChapters` and passes the same array to both consumers — there is no display/speech divergence.
- The **cleaning module is pure** — no React, no IDB, no DOM. Every function is a `string → string` or array transform, trivially unit-testable. It mirrors the style of `lib/parse/util.ts:splitParagraphs` and `hooks/useParagraphPlayer.ts:flattenParagraphs`.
- `useParagraphPlayer` gains **invalidate-on-chapters-change**: when the `chapters` reference changes (cleaning toggled, or any other reason), the hook bumps its generation token, revokes the queue, and re-primes from the current paragraph index. This extends the existing voice-change invalidation.
- Settings stay a **low-frequency Context** value; cleaning config lives there alongside theme/voice/playbackRate. Playback state is still never in Context.

## Commands

Unchanged from M3 — run at the workspace root:

```
pnpm install              # install deps (no additions in M4)
pnpm dev                  # Vite dev server (web/)
pnpm build                # production build → web/dist
pnpm typecheck            # tsc --noEmit
pnpm lint                 | biome check (spike/ excluded)
pnpm lint:fix             # biome check --write
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build (run before commits)
```

## Project structure (additions under `web/src/`)

```
lib/clean/
  types.ts                NEW — CleaningFilters, PronunciationEntry, CleaningConfig
  filters.ts              NEW — stripUrls, stripImages, stripFootnoteRefs,
                                 isPageNumberLine (pure string transforms)
  pronunciation.ts        NEW — applyPronunciation (escaped, whole-word, ci)
  index.ts                NEW — cleanText, cleanParagraphs, cleanChapters
  filters.test.ts         NEW — each filter on representative strings
  pronunciation.test.ts   NEW — whole-word, case-insensitivity, escaping, ordering
  index.test.ts           NEW — end-to-end cleanParagraphs/cleanChapters,
                                 empty-drop, enabled:false passthrough
context/settings.tsx      + cleaning: CleaningConfig on Settings + DEFAULT_SETTINGS
routes/reader.tsx         + useMemo(cleanedChapters); pass to player + ReaderView
hooks/useParagraphPlayer.ts  + invalidate-on-chapters-reference-change
routes/settings.tsx       + cleaning section (master toggle, filter rows,
                            pronunciation editor: add/edit/delete)
routes/reader.test.tsx        + cleaned-text assertions
hooks/useParagraphPlayer.test.ts  + chapters-change invalidation
routes/settings.test.tsx      + cleaning section: toggle + entry CRUD
```

## Code style

Follows `.opencode/tech/typescript/patterns.md` + `react/patterns.md` and the M0–M3 conventions. Highlights:

- **Strict TS**, branded IDs, `import type` for type-only imports (`verbatimModuleSyntax`)
- **Container/presentational split** — `reader.tsx` owns the derivation + playback state; `ReaderView` / settings UI stay props-only
- **Context for low-frequency state only** (settings) — cleaning config lives there; playback + derived chapters live in the container
- **Variant types** for async/machine states; cleaning does not add a new top-level variant
- **Define the contract before implementing** — `CleaningConfig` + function signatures before the filter bodies
- **Pure functions first** — the entire `lib/clean/` module has no side effects, making it trivial to test and safe to call from `useMemo` (referential transparency)
- No comments unless asked; Biome handles format/import-order (2-space, single quotes, no semicolons, trailing commas)
- **Pronunciation `find` is regex-escaped** before compilation — a user entering `C++` must not crash the regex builder

## Testing strategy

- **Filters** (`lib/clean/filters.test.ts`): each filter on representative strings — `[text](http://x)` markdown link keeps `text`, bare `https://x.y/z` dropped, `www.example.com` dropped; `![alt](url)` dropped entirely, `[Image: diagram]` dropped; `[1]` and `[42]` inline dropped, `[1]: definition` dropped, superscript `¹²` dropped, `(1984)` **kept** (year, not a footnote); standalone `"42"` and `"page 12"` paragraphs flagged as page numbers, `"Chapter 42"` kept.
- **Pronunciation** (`lib/clean/pronunciation.test.ts`): whole-word match (not partial), case-insensitive (`Siobhan`/`SIOBHAN`/`siobhan` all replaced), regex-special chars escaped (`C++`, `$1`, `(paren)`), multiple entries applied in order, empty `find` is a no-op (skip), overlapping entries resolve first-wins.
- **Module** (`lib/clean/index.test.ts`): `cleanParagraphs` drops empties after cleaning; `cleanChapters` preserves chapter `title`/`index`/`id` and only rewrites `paragraphs`; `enabled:false` returns input reference unchanged; a chapter whose paragraphs all empty out becomes `{…, paragraphs: []}`.
- **Reader container** (`routes/reader.test.tsx`, extended): with a cleaning config that drops a known-noise paragraph, the rendered reader omits it and the synthesized text omits it (assert via stub engine `calls`).
- **Player hook** (`hooks/useParagraphPlayer.test.ts`, extended): when the `chapters` reference changes, the queue is invalidated (blob URLs revoked) and the hook re-primes from the current index.
- **Settings UI** (`routes/settings.test.tsx`, extended): master toggle persists; a filter toggle persists; add/edit/delete a pronunciation entry round-trips through `getSetting('app')`.
- **Browser** (chrome-devtools MCP): upload a TXT with URLs, `[1]` markers, and standalone page-number lines → confirm display cleaned + audio cleaned; toggle `urls` off mid-playback → queue re-primes + URL reappears; add a pronunciation entry → spoken text changes; zero console errors; zero cdnjs calls.
- **Coverage target:** `lib/clean/*` >90% (pure logic, high leverage); settings UI + reader wiring smoke-tested.

## Boundaries

- **Always:** `pnpm typecheck && pnpm test && pnpm lint` green before considering a task done; define interfaces (`CleaningConfig`, function signatures) before implementing; escape every pronunciation `find` before regex compilation; keep `lib/clean/` pure (no React/IDB/DOM).
- **Ask first:** adding dependencies; changing the IndexedDB schema version or object-store list; modifying the service-worker precache list; moving cleaning into the parse worker (protocol change).
- **Never:** disable strict TS; mutate stored `Chapter.paragraphs` (cleaning is derived only); depend on a CDN at runtime; put cleaning/playback state in Context (cleaning *config* is fine in Context; *derived chapters* are container-local); delete a failing test to make CI pass; use unescaped user input in a `RegExp` constructor (regex-injection crash risk).

## Success criteria (testable)

1. A paragraph containing a bare URL (`https://example.com/x`) is spoken/displayed without the URL when `urls` is on; with `urls` off, the URL remains.
2. A markdown link `[click here](http://x)` is reduced to `click here` (the link text is kept; the URL is dropped).
3. An inline footnote marker `[12]` is stripped; a parenthesized year `(1984)` is **not** stripped.
4. A standalone `42` paragraph (PDF page number) is dropped entirely; `Chapter 42` is kept.
5. A pronunciation entry `{find: 'Siobhan', replace: 'shi-vawn'}` changes the synthesized/displayed text regardless of case; `C++` as a `find` does not crash the app.
6. Toggling any filter (or the master switch) mid-playback invalidates the pre-render queue and re-primes from the current position within one synth cycle.
7. The displayed reader text and the synthesized audio text are always identical for the same paragraph (no read/hear divergence).
8. Existing users (with a stored `Settings` lacking `cleaning`) hydrate with the full default `CleaningConfig` — no error, no migration step.
9. `pnpm verify` (lint + typecheck + test + build) is green.
10. chrome-devtools MCP run: **zero console errors**; **zero cdnjs network requests**; cleaning verified on display + audio; mid-playback toggle re-primes cleanly.

## Risks (tracked, not blocking)

| Risk | Mitigation |
| ---- | ---------- |
| **Over-aggressive footnote regex deletes story text** | Conservative patterns only: `\[\d{1,3}\]` (markdown/scholarly) and superscript unicode — **not** `(\d+)` which catches years. Each filter has a dedicated unit test including the `(1984)` negative case. |
| **Pronunciation `find` crashes the regex builder** | Every `find` is passed through a regex-escape (e.g. `String.raw`-style escape of `[.*+?^${}()|[]\\`) before compilation. Empty `find` entries are skipped. Unit-tested with `C++`, `$1`, `(group)`. |
| **Mid-playback toggle re-synthesizes the current paragraph (audible blip)** | Accepted — same behavior class as the M2 voice-change invalidation. The current paragraph re-synthesizes with the new cleaning config. Documented as a deviation if it proves more than sub-second. |
| **Empty-after-clean paragraph shifts indices** | `cleanChapters` drops empties from the *same* array handed to both display and player — ids stay consistent within the cleaned view. No id remapping needed. `seekToParagraph` matches against the cleaned array it was given. |
| **Entire chapter empties out** | `flattenParagraphs` yields zero refs for it; `nextChapter`/`prevChapter` advance past it. Edge case; documented; no special UI. |
| **Filter ordering matters (pronunciation should see filtered text)** | Fixed order: structural filters (`cleanText`) run first, pronunciation (`applyPronunciation`) runs on the result. Encoded in `cleanParagraphs`; unit-tested. |
| **Service worker caches stale M4 bundle** | Existing gotcha #3: test via `pnpm preview` + hard reload, or unregister the SW, when verifying source changes in-browser. |
| **Settings shape change for existing users** | No risk — spread-merge (`{...DEFAULT_SETTINGS, ...stored}`) already fills missing fields. Adding `cleaning` is transparent. No `DB_VERSION` bump. |

## Tasks (ordered, dependency-chained)

| # | Task | Acceptance | Verify | Files |
| - | ---- | ---------- | ------ | ----- |
| T1 | Cleaning module | `cleanText`/`applyPronunciation`/`cleanParagraphs`/`cleanChapters` implemented; all four filters work; pronunciation is escaped + whole-word + case-insensitive; empties dropped; `enabled:false` passthrough | `lib/clean/{filters,pronunciation,index}.test.ts` | `lib/clean/types.ts`, `filters.ts`, `pronunciation.ts`, `index.ts`, `*.test.ts` |
| T2 | Settings additions | `CleaningConfig` on `Settings` + `DEFAULT_SETTINGS`; existing stored record hydrates with defaults via spread-merge (no migration) | `context/settings.test.tsx` (round-trip), or assert via `getSetting('app')` | `context/settings.tsx` |
| T3 | Wire cleaning into reader + player invalidation | `reader.tsx` derives `cleanedChapters` via `useMemo`; passes to player + `ReaderView`; `useParagraphPlayer` invalidates queue on chapters-reference change | `routes/reader.test.tsx` (cleaned text), `hooks/useParagraphPlayer.test.ts` (invalidate) | `routes/reader.tsx`, `hooks/useParagraphPlayer.ts`, tests |
| T4 | Settings UI | Master `enabled` toggle; four filter toggle rows; pronunciation editor (add/edit/delete entries); all persist | `routes/settings.test.tsx` (extended) | `routes/settings.tsx`, test |
| T5 | E2E + browser verify | Display + audio cleaned; mid-playback toggle re-primes; pronunciation entry changes speech; zero console errors; zero cdnjs; `pnpm verify` green | full `pnpm verify` + chrome-devtools MCP | wiring + minor fixes |

**Ordering:** T1 → T2 → T3 → T4 → T5.

**Checkpoints:** A (T1: cleaning module pure + tested) · B (T2–T3: wired, display + audio reflect cleaning) · C (T4: settings UI complete) · D (T5: shipped, verify green).

## Out of scope (later milestones / later passes)

Book-level repetition detection for repeated headers/footers across pages; PDF coordinate-based page-number detection (would require retaining spatial data through the M1 parse); regex/advanced pronunciation patterns with capture groups; per-book override of the global cleaning config; book-cover artwork as Media Session `artwork` (M5); the full library view, reading-position persistence, and cached-model management (M5).
