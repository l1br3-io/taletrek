# PRD: M10 — PDF Structure (pdfjs Outline + AI Fallback)

> **Status:** Done — shipped alongside ADR-0008.
> **Companions:** [`../VISION.md`](../VISION.md), [`../ROADMAP.md`](../ROADMAP.md), [`M1-upload-read.md`](M1-upload-read.md), [`../adr/0008-pdf-structure-extraction.md`](../adr/0008-pdf-structure-extraction.md).

## Objective

Close two gaps in TaleTrek's PDF pipeline:

1. **The PDF parser ignored pdfjs's `getOutline()` API entirely.** ~40–60% of commercial fiction PDFs ship an embedded `/Outlines` bookmark tree that gives perfect chapter segmentation for free. We were running fragile heuristics on text when the author had already declared the structure.
2. **The heuristic fallback (`detectOutline`) was wrong too often on real fiction.** Its keyword regex matched body prose (`"Part of the reason"`, `"Chapter 1 was the worst day"`). Drop caps, page headers/footers, and title-page all-caps lines polluted font-size signals. Users consistently reported wrong outlines.

**User story:** *As a reader of a PDF novel with an embedded outline, the chapter list shows real chapter titles on upload — no button click required. If the PDF has no outline or pdfjs's outline is wrong, I can re-process via AI from the library menu. There is no fragile heuristic in the middle.*

This milestone is a **pure parsing change** plus a small library UX adjustment. It changes **no playback, no storage schema, no settings**.

## Decisions (locked)

| Area | Decision |
| ---- | -------- |
| Tier 1 — outline | **Use `doc.getOutline()` + `doc.getPageIndex(ref)`.** Each top-level entry whose destination resolves to a page index becomes a chapter boundary. Chapter title = outline entry title (HTML-stripped). Nested entries (sub-bookmarks) are ignored in v1 — `ParsedChapter` is flat. |
| Tier 1 — single-chapter fallback | **If outline is absent or has `< 2` resolvable entries, the parser emits a single chapter** using the meta title or filename. The user can re-process via AI from the library. |
| Tier 1 — page-range mapping | **Each chapter spans `[entry.pageIndex, nextEntry.pageIndex)`**, in document order. Pages before the first entry become a "Front Matter" chapter (mirrors EPUB's convention). |
| Tier 1 — mid-page Y split | **The dest array's `top` (`[pageRef, left, top, zoom]`) is captured as `startY`.** `groupPagesIntoChapters` partitions the start page at `startY`: paragraphs whose Y is above the heading stay in the previous chapter; paragraphs at or below go in the new chapter. Without this, mid-page chapter starts would bleed into the wrong chapter and reader outline navigation would land on a paragraph from the chapter before. When `startY` is null (bare `[pageRef]` dest), the whole page is included. A leading body paragraph that textually matches the chapter title is stripped (so the TTS doesn't read "Chapter 5" twice). |
| Tier 1 — dest resolution | **Handle both shapes.** `dest` as string → call `doc.getDestination(name)` first to get the explicit ref array. `dest` as array → use `dest[0]` as the page ref, `dest[2]` (when numeric) as `startY`. Wrap each resolution in try/catch — malformed entries are skipped, not fatal. |
| **Heuristic detector** | **REMOVED.** `web/src/lib/outline/detect.ts` and `web/src/lib/outline/detect.test.ts` deleted. Pre-M10 keyword/numeric/font-size heuristics produced too many false positives on real fiction. AI is strictly better at understanding prose context. |
| **`headingSignals` field** | **REMOVED** from `ParsedChapter`. It was only consumed by the removed heuristic. The PDF parser no longer computes font-size signals. |
| **`assemblePageSignals`, `stripRepeatingPageFurniture`, struct-tree helpers** | **REMOVED** from `pdf.ts`. Each existed only to feed the heuristic. |
| **`flattenParsedChapters` export** | **REMOVED.** Was used to feed Tier-1 multi-chapter output back into the heuristic. AI takes raw paragraphs directly. |
| AI fallback | **The only fallback when Tier 1 misses.** Existing `useOutline.runWithAi()` is unchanged in contract; it flattens whatever the parser produces (single- or multi-chapter) into one paragraph list for the AI engine. |
| Library UX | **Simplified sheet.** "Auto-detect" button removed. For PDFs: "Use PDF outline" + "Use AI". For other formats: "Use AI" only (when engine is available). |
| Trust model | **Tier 1 is trusted absolutely.** If pdfjs's outline is wrong, user must explicitly re-process via AI. No automatic "low-confidence Tier 1" detection. |
| `ParsedChapter` contract | **Simplified.** `{ title, paragraphs }` — `headingSignals` field removed. Breaking type change; no internal consumers remain. |
| `Chapter` contract (DB-stored) | **Unchanged.** `headings?: ChapterHeading[]` stays for backward compat — existing library books may have sub-headings from prior heuristic runs. New uploads won't produce any. |
| Worker boundary | **Unchanged.** Outline work happens inside `pdfParser.parse()`, which runs in the parse worker. Protocol and main-thread client untouched. |
| Resume position (M5) | **Backward-compatible.** M5 stores position as `{ chapterIdx, paragraphIdx }`. Existing PDF books have `chapterIdx = 0`; after M10 a re-parse produces N chapters, but `chapterIdx = 0` still resolves — user lands at start of chapter 1 of N. **No migration code; no DB bump.** |
| Licensing | ADR-0002 (MIT pipeline) unchanged; no new runtime dependencies. |

## Technologies (additions to M0–M9)

| Package | Version | License | Purpose |
| ------- | ------- | ------- | ------- |
| — | — | — | **No new dependencies.** Uses existing `pdfjs-dist@^6.1.200` (provides `getOutline`, `getDestination`, `getPageIndex`), existing AI engine contract (`engine.detectOutline`). |

Adding runtime dependencies is ask-first per M0 boundaries. M10 adds zero.

## Domain model

```ts
// web/src/lib/parse/types.ts — SIMPLIFIED (headingSignals removed)
export interface ParsedChapter {
  title: string
  paragraphs: string[]
}

// web/src/types.ts — UNCHANGED (Chapter.headings kept for backward compat)
export interface Chapter {
  id: ChapterId
  bookId: BookId
  index: number
  title: string
  paragraphs: string[]
  /** Sub-headings within this chapter. Populated only by legacy heuristic
   *  runs pre-M10. New uploads will not have any — ADR-0008. */
  headings?: ChapterHeading[]
}

// web/src/routes/library/useOutline.ts — SIMPLIFIED API
export interface UseOutline {
  state: OutlineState
  runWithAi: (bookId, detect) => Promise<boolean>      // AI fallback
  runWithPdfOutline: (bookId) => Promise<boolean>      // Tier 1 re-apply
  reset: () => void
}
```

## Architecture

```
pdfParser.parse(file)
  ├─ extractOutline(doc)              ← pdfjs getOutline + getPageIndex
  │   └─ resolves each top-level entry's dest to a 0-based page index
  ├─ Walk pages, collect paragraphs
  └─ Either:
      ├─ groupPagesIntoChapters(outline, pages, title)   ← Tier 1 hit
      └─ flat single-chapter output                       ← Tier 1 miss

Library → "Outline" → OutlineSheet
  ├─ Use PDF outline  → useOutline.runWithPdfOutline(bookId)   [PDFs only]
  └─ Use AI           → useOutline.runWithAi(bookId, detect)
```

## Behaviour matrix

| PDF shape                                      | Outline? | Resulting chapters                       | Notes                                            |
| ---------------------------------------------- | -------- | ---------------------------------------- | ------------------------------------------------ |
| Modern commercial ebook (O'Reilly, KDP export) | ✓        | N (real chapter titles)                  | Tier 1 — chapters appear on upload               |
| Academic preprint (arXiv)                      | ✓        | N (sections as "chapters")               | Tier 1                                           |
| Project Gutenberg text-only PDF                | ✗        | 1 (whole doc) → user re-processes via AI | No heuristic fallback; AI required for splitting |
| Old/novel PDF (no outline declared)            | ✗        | 1 (whole doc) → user re-processes via AI | Same                                             |
| Scanned PDF                                    | —        | —                                        | `ParseError` (unchanged)                         |

## Testing

### `web/src/lib/parse/pdf.test.ts` (~210 LoC)

- `pdfParser.matches` — extension + mime detection (unchanged).
- **`groupItemsIntoParagraphs`** — joins items on the same line; small vertical steps wrap within a paragraph; large gaps start new paragraphs; preserves each paragraph's Y coord; empty-input degenerate case.
- **Tier 1 `extractOutline` with mocked doc** — null for empty/short outlines; resolves string dests via `getDestination`; resolves array dests; captures `startY` from `dest[2]`; sets `startY=null` when dest lacks a numeric top; strips HTML from titles; skips malformed entries; sorts by page index then descending Y for same-page entries.
- **`groupPagesIntoChapters`** — groups whole pages when `startY` is null; splits start page at `startY` (paragraphs above stay in previous chapter); handles two chapter starts on the same page; emits front-matter chapter for paragraphs above the first heading (page 0 mid-page start or page > 0); strips a leading body paragraph matching the chapter title; conservative non-match leaves the paragraph in place; falls back to flat when no entries.

### `web/src/routes/library/useOutline.test.ts` (~210 LoC)

- **`runWithPdfOutline` happy path** — applies multi-chapter parse output, resets position.
- **`runWithPdfOutline` no-outline case** — reports "no embedded outline" when parser produces single chapter.
- **`runWithPdfOutline` error path** — original file evicted → `error` state.
- **`runWithAi` flattens Tier-1 multi-chapter input** — verifies AI receives one flat paragraph list.
- **`runWithAi` "no headings" + error paths.**
- **Re-entrancy guard** for `runWithPdfOutline`.

### `web/src/routes/library/OutlineSheet.test.tsx` (~100 LoC)

- Renders nothing when closed.
- Title switches between "Re-process outline" (PDF) and "Detect chapters" (other formats).
- "Use PDF outline" button visibility rules (PDFs only, requires handler).
- AI button rendering + offline-disabled state.

### `web/src/routes/library.test.tsx` (existing, lightly edited)

- The two "Auto-detect" tests were deleted (button no longer exists).
- One test replaced to verify the sheet no longer offers Auto-detect.

## Acceptance criteria

1. A PDF with an embedded outline produces multiple chapters at parse time with titles matching the outline. ✓
2. A PDF without an embedded outline produces a single flat chapter; the user can re-process via AI. ✓
3. A scanned PDF still throws the existing `ParseError`. ✓
4. `pnpm verify` passes (lint + typecheck + test + build). ✓
5. Library outline sheet for PDFs shows: "Use PDF outline" + "Use AI". For other formats: "Use AI" only. ✓
6. Library menu action is labeled "Re-process outline" (not "Generate outline") since pdfjs Tier 1 runs automatically on upload. ✓
7. Mid-page chapter starts split at `startY`: paragraphs above the heading stay in the previous chapter, paragraphs at or below go in the new chapter. Reader outline navigation lands on the heading paragraph, not a paragraph from the chapter before. ✓
8. A leading body paragraph that matches the chapter title is stripped (no "Chapter 5" then "Chapter 5: The Discovery" TTS duplication). ✓
9. Manual browser smoke against a real PDF with embedded outline (deferred to release verification — not automatable in jsdom).

## Known limitations (non-goals for v1)

- **No heuristic fallback.** PDFs without an embedded outline require AI for splitting. Pre-M10 they got a (often-wrong) heuristic outline; now they get nothing deterministic. Honest tradeoff per ADR-0008.
- **No Level 2 sub-headings for new uploads.** The removed heuristic was the only producer of `Chapter.headings`. Existing library data keeps its sub-headings; new uploads won't have any. The M7 outline UI continues to render them when present.
- **Nested outline entries** (sub-bookmarks) are flattened to top-level only. No hierarchical chapter UI in v1.
- **Multi-column PDFs** may still interleave columns. Pre-existing pdfjs limitation, not worsened.
- **Resume position drift** for existing library PDFs: a previously-uploaded PDF may land at chapter 1 start on first post-M10 open. Acceptable; no migration.
- **OCR for scanned PDFs** — out of scope.

## Implementation summary

| File                                                | Change                                                                                | LoC Δ        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------ |
| `web/src/lib/parse/pdf.ts`                            | Tier 1 only: `extractOutline` (captures `startY`), `groupPagesIntoChapters` (mid-page Y split + body-heading strip), `groupItemsIntoParagraphs` (replaces `assemblePageText` + `splitParagraphs`; preserves per-paragraph Y). | +390 / -290  |
| `web/src/lib/parse/types.ts`                          | Removed `headingSignals?: number[]` from `ParsedChapter`.                              | -3           |
| `web/src/lib/outline/` (folder)                       | **DELETED** — heuristic detector + tests.                                              | -413         |
| `web/src/routes/library/useOutline.ts`                | Removed `run()` heuristic method. Kept `runWithAi` (flattens first) + `runWithPdfOutline`. | -85 / +30    |
| `web/src/routes/library/OutlineSheet.tsx`             | Removed "Auto-detect" button. Two-button sheet (PDF outline + AI).                    | -15 / +5     |
| `web/src/routes/library/useLibraryState.ts`           | Removed `handleOutlineAutoDetect`.                                                     | -8           |
| `web/src/routes/library/LibraryPage.tsx`              | Drop `onAutoDetect` wiring.                                                           | -2           |
| `web/src/routes/library/BookCard.tsx`                 | Menu action relabeled "Outline" → "Re-process outline"; aria-label updated to match (Tier 1 is automatic on upload). | -1 / +1      |
| `web/src/lib/parse/pdf.test.ts`                       | Removed signal/struct/header tests. Migrated `assemblePageText` tests to `groupItemsIntoParagraphs`; added `startY` capture, mid-page split, same-page two-chapter, front-matter-mid-page, body-heading-strip coverage. | -310 / +220  |
| `web/src/routes/library/useOutline.test.ts`           | Removed heuristic `run` tests. Kept AI + PDF outline.                                  | -200 / +180  |
| `web/src/routes/library/OutlineSheet.test.tsx`        | Updated to drop Auto-detect assertions.                                                | -10          |
| `web/src/routes/library.test.tsx`                     | Removed two Auto-detect flow tests; updated remaining tests for "Re-process outline" label. | -45 / +25    |
| `docs/adr/0008-pdf-structure-extraction.md`           | Rewritten for 2-tier (was 3-tier).                                                    | +50 / -80    |
| `docs/prds/M10-pdf-structure.md`                      | This file — rewritten for shipped 2-tier design.                                      | +130 / -130  |
| `docs/ROADMAP.md`                                     | M10 description simplified.                                                            | -2 / +2      |
| `AGENTS.md`                                           | Gotcha #17 simplified.                                                                 | -2 / +2      |
| **Net**                                                 |                                                                                        | **~−950 LoC** |

## Verification

`pnpm verify` (lint + typecheck + test + build) passes. Test count: **766** (was 760 before the Y-coord fix; +6 covering mid-page split, same-page two-chapter, descending-Y sort, body-heading strip, front-matter mid-page start, and the no-strip loose-resemblance case).

Manual browser smoke (deferred to release verification):
- Open a PDF with embedded outline. Confirm correct chapters appear on upload with no button click.
- Confirm clicking a chapter in the reader's Outline panel navigates to the heading paragraph, not the first paragraph of the page.
- Open a PDF without outline. Confirm single-chapter; open library menu → Re-process outline → confirm only "Use AI" is offered.
- Open a previously-uploaded PDF. Confirm it still opens; resume may land at chapter 1 start (documented limitation).
