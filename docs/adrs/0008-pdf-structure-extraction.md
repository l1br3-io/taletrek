# ADR-0008: Trust pdfjs outline; AI is the only fallback

- **Status:** Accepted (revised 2026-07-18 — supersedes the original 3-tier M10 design)
- **Date:** 2026-07-18
- **Companion:** [`../specs/pdf-structure/spec.md`](../specs/pdf-structure/spec.md), [`0002-mit-piper-pipeline.md`](./0002-mit-piper-pipeline.md) (licensing)

## Context

Pre-M10, TaleTrek's PDF outline pipeline was a single tier:

1. `pdfParser.parse()` (`web/src/lib/parse/pdf.ts`) extracted raw text + per-paragraph max font size from every page, emitting **one flat chapter** for the whole document.
2. `detectOutline()` (`web/src/lib/outline/detect.ts`, since removed) optionally re-segmented that flat chapter into multiple chapters via heuristics: keyword regex (`^(chapter|part|...)\b`), all-caps detection, numeric section prefixes, font-size ratio thresholds.

Two problems surfaced:

- **The heuristic engine had several real-world bugs.** Its keyword regex matched body prose like `"Part of the reason was..."` and `"Chapter 1 was the worst day..."`. Drop caps, page headers/footers, and title-page all-caps lines all polluted font-size signals. Users consistently reported wrong outlines. AI-based detection worked because the LLM understood prose context that the regex didn't.
- **The PDF parser ignored pdfjs's structural APIs entirely.** ~40-60% of commercial fiction PDFs ship an embedded `/Outlines` bookmark tree (`doc.getOutline()`) that gives perfect chapter segmentation for free. We were running fragile heuristics on text when the author had already declared the structure.

The original M10 design (ship a 3-tier fallback: pdfjs outline → pdfjs struct tree → fixed heuristics) was implemented first. After using it, the project owner directed: **if pdfjs's outline doesn't work for a given PDF, just rely on AI. Remove the reinvented heuristic detection entirely.** This ADR records that decision.

## Decision

**Two-tier outline model. pdfjs's `getOutline()` is the only deterministic source. AI is the only fallback. The heuristic detector is deleted.**

```
Upload PDF
  └─ pdfParser.parse()
      └─ Tier 1: doc.getOutline()
          ├─ hit (≥ 2 resolvable entries) → multi-chapter output, done
          └─ miss → single-chapter output

User wants different segmentation?
  └─ Library menu → Outline → Re-process outline sheet
      ├─ "Use PDF outline" → runWithPdfOutline (re-applies Tier 1)
      └─ "Use AI"          → runWithAi (cloud LLM, requires user's API key)
```

No heuristic. No font-size signals. No struct tree integration. No "Auto-detect" button.

### What was removed

| Removed                                                | Reason                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `web/src/lib/outline/detect.ts` (entire file)            | The heuristic detector. False-positive prone on real fiction; AI is strictly better at prose context.                  |
| `web/src/lib/outline/detect.test.ts` (entire file)        | Tests for the removed heuristic.                                                                                        |
| `ParsedChapter.headingSignals?: number[]`                | The per-paragraph max font size was only consumed by the heuristic. With no detector, the field has no consumer.       |
| `useOutline.run()`                                      | The heuristic detection entry point.                                                                                    |
| `OutlineSheet` "Auto-detect" button                      | UI surface for the removed heuristic.                                                                                   |
| `assemblePageSignals` in `pdf.ts`                        | Produced signals only the heuristic consumed.                                                                           |
| `applyStructSignals` / `collectStructHeadingIds` (Tier 2) | Struct tree was only useful as signal boost for the heuristic. Without the heuristic, struct tree has no consumer.     |
| `stripRepeatingPageFurniture` in `pdf.ts`                | Cross-page header/footer filter was only meaningful as input cleanup for the heuristic.                                 |
| `flattenParsedChapters`                                 | Was used to feed Tier-1 multi-chapter output back into the heuristic detector. AI takes raw paragraphs directly.        |

### What was kept

| Kept                                         | Reason                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `extractOutline()` (Tier 1) in `pdf.ts`        | The pdfjs `getOutline()` integration. Authoritative when present.                                                   |
| `groupPagesIntoChapters()` in `pdf.ts`         | Splits per-page paragraphs into chapters using outline destinations.                                                |
| `useOutline.runWithPdfOutline()`              | Re-applies Tier 1 on demand (e.g. after a parser update or to revert an AI override).                               |
| `useOutline.runWithAi()`                       | Cloud fallback when Tier 1 returns nothing. Existing AI engine contract (`engine.detectOutline`) is unchanged.       |
| `Chapter.headings?: ChapterHeading[]` type      | Backward compat: existing books in IDB may have Level 2 sub-headings from prior detection runs. Untouched on disk.  |
| M7 reader `Outline` component                 | Renders existing `Chapter.headings` when present. New books won't have any; the UI handles undefined gracefully.     |

## Alternatives considered

| Alternative                                                            | Why rejected                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 3-tier fallback (pdfjs outline → pdfjs struct tree → fixed heuristics) | Original M10 design, implemented first. Owner rejected: "REMOVE everything from those 'reinvented' detection. Its not needed." Heuristics don't add value over AI when AI is available. |
| Keep heuristics behind a feature flag                                 | Adds maintenance surface for code that's strictly worse than AI. No users to default into the flag. |
| Add a "low-confidence Tier 1" detection that auto-falls-back to AI    | Premature. If real users hit bad pdfjs outlines, add it later. For now, trust pdfjs and let users explicitly choose AI when needed. |
| Replace pdfjs with `mupdf-js` for `toStructuredText("json")`           | **AGPL** — conflicts with ADR-0002 (MIT pipeline).                                          |
| Replace pdfjs with `markitdown` / `marker` / `nougat` / `mineru`       | Python/server-side. Antithetical to TaleTrek's offline-PWA thesis (VISION non-goal: cloud). |

## Consequences

- **Simpler codebase.** ~700 LoC of heuristic logic + tests removed. The PDF parser is now ~280 lines (down from ~600 at peak of 3-tier M10). `ParsedChapter` is a plain `{ title, paragraphs }` shape.
- **No false positives from heuristics.** The `"Part of the reason"` / drop caps / running headers failure modes are gone — there's no heuristic left to false-positive.
- **AI becomes required for non-PDF outline splitting.** TXT, MOBI, and Markdown books ship no structural metadata; only AI can split them now. Users without an AI engine configured see the Outline button open a sheet with no available actions. Accepted: TaleTrek's AI layer is opt-in (ADR-0003-0005), and the EPUB parser already covers structured ebook formats.
- **PDFs without embedded outline (Project Gutenberg, scans, old exports) need AI for splitting.** Pre-M10 they got a bad heuristic outline; post-M10 they get nothing deterministic. This is honest — the heuristic was wrong more often than right on these files anyway.
- **No more Level 2 sub-headings for new uploads.** The heuristic was the only producer of `Chapter.headings` (sub-headings within a chapter). New books won't have them; existing library data is untouched. The M7 outline UI continues to render them when present.
- **`ParsedChapter` contract simplifies.** Removing `headingSignals` is a breaking type change for any external caller reading the field. No internal callers remain. The DB-stored `Chapter` shape is unchanged.
- **No new runtime dependencies.** `pdfjs-dist@^6.1.200` already provides `getOutline`, `getDestination`, `getPageIndex`. ADR-0002 (MIT pipeline) is unaffected.

## Tradeoffs accepted

- **Heuristic was sometimes right.** A small minority of PDFs (clean `"Chapter N"` structure, no prose ambiguity) got correct outlines from the heuristic without needing AI. Those users now need AI configured. The tradeoff: those users were a minority, and the heuristic was wrong for everyone else.
- **AI requires a cloud key.** The ADR-0004 threat model applies — in-memory key, no storage, user pastes per session or uses ADR-0007 PRF biometric caching. The outline flow inherits that constraint.
- **Existing library books with heuristic-generated outlines keep their data.** No migration. A user who previously had a (possibly wrong) heuristic outline can re-process via PDF outline or AI to overwrite it.
- **Sub-bookmarks (nested outline entries) still flattened.** Same as original M10. `ParsedChapter` is flat — hierarchical outline UI is future work.
