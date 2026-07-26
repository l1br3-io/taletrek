# PRD: M1 — Upload & Read

> **Status:** Ready to implement.
> **Companions:** [`../../VISION.md`](../VISION.md), [`../../ROADMAP.md`](../ROADMAP.md), [`M0-foundation.md`](M0-foundation.md), [`../spikes/piper-wasm.md`](../spikes/piper-wasm.md).

## Objective

Turn `/reader` from a placeholder into a working ingest pipeline: pick a PDF, EPUB, or TXT file via the browser's native file picker, parse it inside a Web Worker, extract clean paragraph text, persist the raw blob plus parsed chapters to IndexedDB, and render a scrollable reader view that reopens the most-recent book across reloads. This milestone proves the full ingest pipeline — from file to readable text — works in the browser.

**User story:** *As a reader, I upload a book once; TaleTrek extracts its text and shows it in a clean reader — and it's still there when I come back tomorrow, offline.*

MOBI is **spiked separately after the three-format slice ships** — it is the only format with no healthy off-the-shelf browser parser.

## Decisions (locked)

| Area        | Decision                                                                          |
| ----------- | --------------------------------------------------------------------------------- |
| Formats     | PDF + EPUB + TXT first; MOBI as a dedicated spike after the slice is green         |
| Parsing     | All formats run inside one Web Worker (UI never blocks; M2-ready infra)           |
| Persistence | Raw blob (source of truth) + parsed chapters in IndexedDB                         |
| Reader UX   | Reopen most-recent book + always-available Upload (full library view deferred to M5) |

## Technologies (additions to M0)

| Package    | Version | License    | Purpose                                        |
| ---------- | ------- | ---------- | ---------------------------------------------- |
| `pdfjs-dist` | ^6.1    | Apache-2.0 | PDF text extraction (ships its own worker)     |
| `jszip`      | ^3      | MIT        | Unzip EPUB → XHTML                             |
| `fast-xml-parser` | ^4 | MIT   | Worker-safe XML/XHTML parsing for EPUB (Web Workers have no `DOMParser`) |

TXT uses native `FileReader` / `TextDecoder`. MOBI (later) will be a self-written minimal parser — no dependency. Adding dependencies is ask-first per M0 boundaries; both are MIT/Apache-compatible with TaleTrek's MIT license (ADR-0002).

## Domain model (first branded types in the codebase)

```ts
type BookId    = string & { readonly __brand: 'BookId' }
type ChapterId = string & { readonly __brand: 'ChapterId' }
type BookFormat = 'pdf' | 'epub' | 'txt'           // 'mobi' added by the T8 spike

interface Book {
  id: BookId
  title: string
  format: BookFormat
  chapterCount: number
  createdAt: number
  updatedAt: number
}
interface Chapter {
  id: ChapterId
  bookId: BookId
  index: number          // 0-based order within the book
  title: string
  paragraphs: string[]   // each entry renders as one <p>
}
```

`paragraphs: string[]` (not one blob) — renders straight to `<p>` blocks, and makes M2/M3 TTS chunking and M4 cleaning per-paragraph trivial. Formats without structure (TXT, most PDFs) emit a single chapter titled from the filename or metadata.

## IndexedDB schema (bump v1 → v2)

```
settings  (unchanged, out-of-line keys)
books     { keyPath: 'id' }   index: 'updatedAt'        # most-recent query
chapters  { keyPath: 'id' }   index: 'bookId'           # as reserved in M0 PRD
files     { keyPath: 'bookId' }  { bookId, blob, name, type, size }   # NEW — keeps listings blob-free
```

The `files` store extends the M0 reservation (which listed only `books`/`chapters`) so a future book list (M5) never loads raw blobs when listing. The `upgrade()` callback runs once for existing M0 users; the `settings` store is left untouched.

## Parser contract (interface-first)

```ts
interface ParseResult {
  title: string
  chapters: Array<{ title: string; paragraphs: string[] }>
}
interface Parser {
  format: BookFormat
  matches(file: File): boolean   // sniff by extension/mime
  parse(blob: Blob): Promise<ParseResult>
}
```

Each format implements `Parser`; `parseFile(file)` sniffs the extension and dispatches to the matching parser. Unsupported extensions surface a typed error.

## Architecture

```
File input ──► parseClient ──► [Parse Worker: parseFile() → Parser] ──► ParseResult
               (promise wrap)         │ pdfjs runs its own sub-worker
                                     ▼
             reader container ──► db: write Book + Chapters + File ──► ReaderView
```

- `routes/reader.tsx` becomes the **first container** in the codebase (owns the upload state machine and the route loader); `UploadButton` and `ReaderView` stay presentational.
- The `/reader` **loader** runs `getMostRecentBook()` plus its chapters and returns `{ book, chapters } | null`.
- The upload state uses the established variant-type idiom: `{ type: 'idle' } | { type: 'parsing'; fileName } | { type: 'error'; message }`.

## Commands

Unchanged from M0 — run at the workspace root:

```
pnpm install              # install deps (adds pdfjs-dist, jszip)
pnpm dev                  # Vite dev server (web/)
pnpm build                # production build → web/dist
pnpm typecheck            # tsc --noEmit
pnpm lint                 # biome check (spike/ excluded)
pnpm lint:fix             # biome check --write
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build (run before commits)
```

## Project structure (additions under `web/src/`)

```
types.ts                       BookId, ChapterId, BookFormat, Book, Chapter
lib/
  db.ts                        v2 upgrade + books/chapters/files CRUD + getMostRecentBook
  db.test.ts                   extended round-trip + ordering tests
  parse/
    types.ts                   Parser, ParseResult, ParseError
    dispatcher.ts              parseFile() — extension sniff + dispatch
    txt.ts                     TXT parser (blank-line → paragraphs)
    epub.ts                    EPUB parser (jszip + DOMParser)
    pdf.ts                     PDF parser (pdfjs-dist getTextContent)
    __fixtures__/              tiny license-free sample files
    client.ts                  worker promise wrapper
    *.test.ts                  per-parser unit tests
workers/
  parse.worker.ts              runs the dispatcher; posts result/error
components/
  UploadButton.tsx             (presentational) file input + parsing spinner
  ReaderView.tsx               (presentational) renders Book + chapters
routes/
  reader.tsx                   (container — replaces placeholder)
  landing.tsx                  (adds an "Upload a book" CTA → /reader)
```

## Code style

Follows `.opencode/tech/typescript/patterns.md` + `react/patterns.md` and the M0 conventions. Highlights:

- **Strict TS**, branded IDs (`type BookId = string & { readonly __brand: 'BookId' }`), `import type` for type-only imports (`verbatimModuleSyntax`)
- **Container/presentational split** — `reader.tsx` owns data + state; `UploadButton` / `ReaderView` are pure props
- **Context for low-frequency state only** (settings/theme) — reader/book state lives in the route loader + component state, never Context
- **Variant types** for async states: `{ type: 'idle' } | { type: 'parsing'; fileName } | { type: 'error'; message } | { type: 'ready'; book }`
- **Define the contract (interface) before implementing** — `Parser` before any concrete parser
- No comments unless asked; Biome handles format/import-order (2-space, single quotes, no semicolons, trailing commas)

## Testing strategy

- **Parsers** (`lib/parse/*.test.ts`): unit tests against committed fixtures under `lib/parse/__fixtures__/` (a hand-built minimal EPUB, a tiny PDF, a sample TXT) — assert title + chapter/paragraph extraction.
- **DB** (`db.test.ts`): extend with books/chapters/files round-trip, `getMostRecentBook` ordering, and durability — same `_resetDBForTests()` pattern as M0.
- **Components**: reader empty / parsing / error / ready states via Testing Library; loader tested with `fake-indexeddb`.
- **Worker**: parser functions tested directly (the worker is a thin shell); the client wrapper tested with a mocked worker.
- **Browser**: chrome-devtools MCP — upload each format, hard-reload → book persists, offline, zero console errors.
- **Coverage target:** `lib/` >80% (per M0); parser happy-path plus one failure case each.

## Boundaries

- **Always:** `pnpm typecheck && pnpm test && pnpm lint` green before considering a task done; validate inputs at module boundaries; define interfaces before implementing.
- **Ask first:** adding dependencies (`pdfjs-dist`, `jszip`); changing the IndexedDB schema version; modifying CI config; touching `vite-plugin-pwa` strategy.
- **Never:** commit secrets or large binary models; bundle parsers into the main chunk (keep them in the worker); disable strict TS; delete a failing test to make CI pass.

## Success criteria (testable)

1. Upload a PDF, an EPUB, and a TXT — each extracts readable paragraph text in `/reader`.
2. A hard-reload reopens the most-recent book with its text intact (no re-upload needed).
3. Parsing never blocks the UI (runs in a worker); a parsing spinner shows during extraction.
4. A corrupt / unsupported / scanned-image-only PDF surfaces a friendly error state — no crash, no console errors.
5. `pnpm verify` (lint + typecheck + test + build) is green.
6. chrome-devtools MCP run: **zero console errors**; upload → reload → text persists; works offline.
7. The reader respects the existing theme/font-scale settings.
8. The landing page offers an "Upload a book" CTA that routes to `/reader`.

## Risks (tracked, not blocking)

| Risk                                                                  | Mitigation                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Web Workers have no `DOMParser`** (discovered in T7)                     | EPUB parser uses `fast-xml-parser` (worker-safe) instead; TXT and PDF need no DOM parsing              |
| **PDF.js inside our worker** runs inline ("fake worker")                     | pdf.js runs as a library within our worker thread — still off the main UI thread; UX unaffected         |
| **pdf.js warns** about `standardFontDataUrl` + fake worker                  | Benign `warn`-level logs during text extraction (no errors); text extraction is correct; revisit if M2 needs richer PDF fidelity |
| **pdfjs-dist worker version mismatch** (mirrors the ORT pinning gotcha)    | Import the worker via `pdfjs-dist/build/pdf.worker.min.mjs?url` so versions stay in lockstep            |
| **EPUB2 vs EPUB3** (NCX vs nav toc)                                       | Both toc formats handled in `epub.ts`                                                                 |
| **Bundle size** (pdfjs-dist is large)                                      | Isolate in the worker chunk — Vite code-splits workers; main bundle unaffected                         |
| **MOBI deferred**                                                          | Explicitly out of the first slice; spiked separately in T8                                            |
| **Safari 7-day ITP eviction** (inherited from M0)                          | `navigator.storage.persist()` already requested; the raw blob is source of truth and re-hydratable    |

## Tasks (ordered, dependency-chained)

| #   | Task                          | Acceptance                                                                                  | Verify                                             | Files                                                                  |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| T1  | Types + DB v2                 | Branded types; DB upgrades to v2; books/chapters/files CRUD; `getMostRecentBook`              | `db.test.ts` round-trip + ordering green             | `types.ts`, `lib/db.ts`, `lib/db.test.ts`                                  |
| T2  | Parser contract + TXT         | `Parser`/`ParseResult`; `parseFile()`; TXT parser (blank-line → paragraphs)                     | parser unit test with fixture                      | `lib/parse/{types,dispatcher,txt}.ts`, fixture, test                     |
| T3  | EPUB parser                   | jszip + DOMParser; spine → text; NCX/nav titles                                             | parser unit test                                   | `lib/parse/epub.ts`, fixture, test                                       |
| T4  | PDF parser + worker spike     | pdfjs `getTextContent` per page → paragraphs; metadata title; validates workerSrc             | parser unit test; decision record on nested-worker | `lib/parse/pdf.ts`, fixture, test                                        |
| T5  | Parse Worker + client         | worker wraps dispatcher; client promise wrapper; error path                                 | client test (mocked worker)                        | `workers/parse.worker.ts`, `lib/parse/client.ts`, test                   |
| T6  | Reader UI (container + views) | loader; upload state machine; `UploadButton` + `ReaderView`; landing CTA; replaces placeholder | component tests for all 4 states                   | `routes/{reader,landing}.tsx`, `components/{UploadButton,ReaderView}.tsx`, tests |
| T7  | End-to-end + browser verify   | upload→parse→persist→render for all 3 formats; reload persists; offline; 0 console errors   | MCP run, `pnpm verify`                             | (wiring + minor fixes)                                                 |
| T8  | MOBI spike (deferred)         | decision: minimal self-written parser or punt; add `'mobi'` format if viable                | spike doc + parser tests if built                  | `docs/spikes/mobi.md`, maybe `lib/parse/mobi.ts`                         |

**Ordering:** T1 → T2 → (T3 ∥ T4) → T5 → T6 → T7; T8 independent after T2's contract exists.

## Out of scope (later milestones)

TTS and audio playback (M2), background/Jog mode and Media Session playback (M3), the cleaning pipeline that strips links/images/footnotes (M4), the full library view with covers/progress (M5), and MOBI support (T8 spike under M1).
