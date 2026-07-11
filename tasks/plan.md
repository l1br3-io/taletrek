# M1 — Upload & Read · Plan

> Per-task detail for [`todo.md`](./todo.md). Spec: [`docs/prds/M1-upload-read.md`](../docs/prds/M1-upload-read.md).
> Ordering: T1 → T2 → (T3 ∥ T4) → T5 → T6 → T7; T8 independent after T2's contract.

## Resuming

**As of 2026-07-11:** M1 three-format slice (T1–T7) is **complete**. `pnpm verify`
reconfirmed green this session — `pnpm lint` ✅, `pnpm typecheck` ✅, `pnpm test`
✅ (49 tests across 9 files), `pnpm build` ✅ (91 modules, PWA generated).

**Completed:** Branded types + DB v2 (books/chapters/files stores), the
`Parser` contract, TXT/EPUB/PDF parsers, a Web Worker + promise-wrapping client,
and the reader container with `UploadButton`/`ReaderView` + landing CTA.
Hard-reload reopens the most-recent book; parsing runs off the main thread.

**Working tree:** the M1 implementation is **uncommitted** — run
`git status --porcelain` for the live count. Last commit: `27ac4ef docs: add
AGENTS.md`. Land the work before starting T8.

**3 deviations on record** — read before continuing:
1. **EPUB parser uses `fast-xml-parser`, not `DOMParser`.** The PRD's project
   structure listed "jszip + DOMParser", but Web Workers have no `DOMParser`
   (AGENTS.md gotcha #6). Implementation diverged to `fast-xml-parser`
   (worker-safe). The PRD risks table already captures the discovery.
2. **Two extra modules beyond the PRD file list:** `lib/parse/protocol.ts`
   (typed worker message protocol) and `lib/parse/util.ts` (shared helpers).
3. **Fixture strategy differs:** only `sample.txt` is committed under
   `__fixtures__/`; EPUB/PDF fixtures are generated at test time by
   `web/scripts/gen-fixtures.mjs` (untracked) rather than committed as binaries.

---

## Tasks

### T1 — Types + DB v2 · ✅ done
- **Detail:** Branded `BookId`/`ChapterId` types; IndexedDB upgrades M0 v1 → v2
  with `books`, `chapters`, `files` stores; `getMostRecentBook()`.
- **Depends on:** — (foundation).
- **Acceptance:** CRUD round-trip for all three stores; `getMostRecentBook`
  ordering by `updatedAt` correct.
- **Verify:** `db.test.ts` (15 tests).
- **Files:** `web/src/types.ts`, `web/src/lib/db.ts`, `web/src/lib/db.test.ts`.

### T2 — Parser contract + TXT · ✅ done
- **Detail:** `Parser`/`ParseResult` interfaces; `parseFile()` sniffs extension
  and dispatches; TXT parser splits blank-line-separated paragraphs.
- **Depends on:** T1 (types).
- **Acceptance:** contract defined before concrete parsers; TXT fixture extracts
  title + paragraphs.
- **Verify:** `parse/txt.test.ts` (8 tests).
- **Files:** `web/src/lib/parse/{types,dispatcher,txt}.ts`, fixture, test.

### T3 — EPUB parser · ✅ done
- **Detail:** jszip + `fast-xml-parser` (worker-safe — **deviation #1**); spine →
  text; handles both NCX and nav toc titles.
- **Depends on:** T2 (contract).
- **Acceptance:** EPUB fixture extracts chapters + paragraphs; both toc formats.
- **Verify:** `parse/epub.test.ts` (6 tests).
- **Files:** `web/src/lib/parse/epub.ts`, test, generated fixture.

### T4 — PDF parser + worker spike · ✅ done
- **Detail:** pdfjs `getTextContent` per page → paragraphs; metadata title;
  worker imported via `pdf.worker.min.mjs?url` to keep versions in lockstep;
  runs inline within our worker thread (off the UI thread).
- **Depends on:** T2 (contract).
- **Acceptance:** PDF fixture extracts text; validates workerSrc.
- **Verify:** `parse/pdf.test.ts` (6 tests).
- **Files:** `web/src/lib/parse/pdf.ts`, test.

### T5 — Parse Worker + client · ✅ done
- **Detail:** `parse.worker.ts` wraps the dispatcher and posts result/error;
  `client.ts` is a promise wrapper with a typed protocol (**deviation #2**).
- **Depends on:** T2, T3, T4 (parsers).
- **Acceptance:** client resolves on success, rejects on error path.
- **Verify:** `parse/client.test.ts` (3 tests, mocked worker).
- **Files:** `web/src/workers/parse.worker.ts`, `web/src/lib/parse/{client,protocol}.ts`, test.

### T6 — Reader UI (container + views) · ✅ done
- **Detail:** `/reader` loader runs `getMostRecentBook`; upload state machine
  (idle/parsing/error/ready variant types); `UploadButton` + `ReaderView` are
  presentational; landing CTA routes to `/reader`.
- **Depends on:** T1, T5 (data + worker client).
- **Acceptance:** component tests cover all four states; loader tested with
  fake-indexeddb.
- **Verify:** `reader.test.tsx` (5 tests), `landing.test.tsx` (3 tests).
- **Files:** `web/src/routes/{reader,landing}.tsx`, `web/src/components/{UploadButton,ReaderView}.tsx`, tests.

### T7 — End-to-end + browser verify · ✅ done
- **Detail:** upload → parse → persist → render for PDF/EPUB/TXT; hard-reload
  reopens the most-recent book; offline; zero console errors.
- **Depends on:** T1–T6 (full slice).
- **Acceptance:** `pnpm verify` green; chrome-devtools MCP run clean.
- **Verify:** full `pnpm verify` green this session (49 tests, build OK).
- **Files:** wiring + minor fixes across the slice.

### T8 — MOBI spike · ⬜ pending (next task)
- **Detail:** The only format with no healthy off-the-shelf browser parser.
- Investigate a minimal self-written MOBI parser vs. punting; if viable, add
  `'mobi'` to `BookFormat` and a `parse/mobi.ts`.
- **Depends on:** T2 (`Parser` contract must exist — it does).
- **Acceptance:** decision recorded in `docs/spikes/mobi.md`; if built, MOBI
  fixture extracts chapters + a parser unit test passes.
- **Verify:** spike doc + `pnpm verify` still green; parser test if implemented.
- **Files:** `docs/spikes/mobi.md`, possibly `web/src/lib/parse/mobi.ts`.
- **Note:** independent of T3–T7; safe to start now. Per the PRD this was always
  deferred until after the three-format slice shipped — which it now has.
