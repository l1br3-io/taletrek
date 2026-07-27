# Plan: M13 — Whole-Book Streaming AI Transform

> **Status:** ✅ Shipped · 2026-07-20 (archived).
> Spec: [`SPEC.md`](./spec.md) ·
> Decisions: [`docs/adrs/0012-whole-book-streaming-transform.md`](../../adrs/0012-whole-book-streaming-transform.md) ·
> Resume precedent: [`docs/adrs/0009-upload-wake-lock-and-boot-sweep.md`](../../adrs/0009-upload-wake-lock-and-boot-sweep.md) ·
> Synth pause/resume precedent: [`docs/adrs/0010-playback-engine-architecture.md`](../../adrs/0010-playback-engine-architecture.md).
>
> **Implementation note:** the build diverged from this plan — the transform
> driver landed at `web/src/lib/transform/manager.ts` (not the planned
> `routes/reader/useBookTransform.ts`) and `GenerationConfirmSheet.tsx` was not
> added. Behaviour shipped and was verified by the author. This plan records the
> original intent; the archived SPEC is the requirements layer.

> The Problem / Decisions / Architecture / State-machine sections live in
> [`SPEC.md`](./spec.md); this file holds the build plan only.

## Phases

### Phase 1 — Extract `<StreamingBlock>` component [refactor, XS, low risk]

**Files:**
- `web/src/routes/reader/StreamingBlock.tsx` (NEW)
- `web/src/routes/reader/StreamingBlock.test.tsx` (NEW)
- `web/src/routes/reader/ReaderView.tsx` (use the new component for the existing single-paragraph F8 stream)

**Behavior:** Extract the existing inline chip + `<p>` + `.tt-streaming` + cursor rendering from `ReaderView.tsx:110-163` into a presentational component. Props:

```ts
interface StreamingBlockProps {
  opLabel: string
  streamingText: string
  // When provided, renders as a <p> with seek/active/pulse semantics (F8 path).
  // When absent, renders as a chunk-stream box (M13 path).
  paragraphRef?: RefObject<HTMLParagraphElement | null>
  isActive?: boolean
  isSeekable?: boolean
  isPulsing?: boolean
  isBuffered?: boolean
  paragraphText?: string  // committed paragraph text (F8 path); M13 path uses streamingText only
  onStop?: () => void
  onSeek?: () => void
  onPulseEnd?: () => void
}
```

**Why first:** Lets Phase 5 add the chunk-stream render path with zero duplication. Same visual signature for both flows. No behavior change in Phase 1 — pure refactor; the F8 single-paragraph stream should look identical before/after.

---

### Phase 2 — `onChunkStreamed` callback in the AI runner [types + runner, S, low risk]

**Files:**
- `web/src/lib/ai/types.ts` — widen `AiTransformEngine.transform` with `onChunkStreamed?: (info: ChunkStreamInfo) => void`
- `web/src/lib/ai/runner.ts` — invoke `onChunkStreamed` at two points: (a) every `onDelta` token batch inside a chunk, (b) chunk completion (with `isFinal: true`)
- `web/src/lib/ai/runner.test.ts` — +tests for callback firing order, chunk context, isFinal flag

**New types:**

```ts
export interface ChunkStreamInfo {
  /** Index of the chunk within the current runTransform call (0-based). */
  chunkIndex: number
  /** Total chunks in this runTransform call. */
  chunkTotal: number
  /** Index into the original `input[]` array where this chunk starts. */
  chunkStartInputIndex: number
  /** Cumulative streamed text for this chunk (resets at chunk boundary). */
  textSoFar: string
  /** Just-arrived delta. */
  delta: string
  /** True when chunk has completed and splitOutput has run. */
  isFinal: boolean
  /** When isFinal, the final split-output paragraphs for this chunk. */
  finalParagraphs?: string[]
}
```

**Runner wiring:** `runTransform` already wraps `onDelta` per-chunk (runner.ts:88-97). Extend the wrapper to also fire `onChunkStreamed` with chunk context. At chunk completion, fire with `isFinal: true` and attach `finalParagraphs: splitOutput(raw)`.

**Why this shape:** It's chunk-aware (caller knows which chunk is streaming, what its position is) but doesn't leak paragraph-level state mid-chunk (caller can't misrender partial paragraphs). The chunk is the atomic streaming unit. Matches the "boxed streaming block per chunk" decision.

---

### Phase 3 — `useBookTransform` hook [new file, L, medium risk]

**Files:**
- `web/src/routes/reader/useBookTransform.ts` (NEW)
- `web/src/routes/reader/useBookTransform.test.ts` (NEW)

**Public surface** (mirrors `uploadManager`):

```ts
interface UseBookTransform {
  state: BookTransformState
  start(args: { book: Book; chapters: Chapter[]; ops: TransformOp[] }): Promise<void>
  pause(): void
  resume(bookId: BookId): Promise<void>
  cancel(): Promise<void>
  retry(): Promise<void>
}

type BookTransformState =
  | { type: 'idle' }
  | { type: 'running'; opLabel: string; done: number; total: number;
      currentChapterTitle: string; streamingBlock: { opLabel: string; text: string; chunkIndex: number; chunkTotal: number } | null }
  | { type: 'paused'; done: number; total: number; currentOpIndex: number }
  | { type: 'done' }
  | { type: 'error'; message: string }
```

**Responsibilities:**

1. **Driver loop:** Mirrors `useAiTransform`'s `for (op) { for (chapter) { engine.transform(...) }}` structure. Each call to `engine.transform` passes `onChunkStreamed` which updates `state.running.streamingBlock` (throttled via rAF).
2. **Pause:** Cooperative abort at next chunk boundary via `AbortController`. Persists `book.transformJob` with `transforming: false`. Idempotent if already paused.
3. **Resume:** Reads `book.transformJob` from IDB, reloads chapters, picks up at `(currentOpIndex, currentChapterIndex, currentChunkIndex)`. The chunk that was mid-stream is **re-sent from scratch** — chunks only commit at their boundary, no half-state.
4. **Cancel:** Clears `transformJob`, `transforming`, keeps already-committed paragraphs (user has investment). Surfaces as `idle`.
5. **Wake lock:** `acquireUploadWakeLock()` on start/resume, released in `finally`.
6. **IDB writes:** `putChapters(working)` after each chunk commit (not per-token). Bumps `book.transformJob.done/currentChunkIndex/currentChapterIndex` in the same write.
7. **Completion:** Writes `updateBookProcessing`, clears `transformJob` + `transforming`, kicks `uploadManager.startJob({mode:'resynth'})` fire-and-forget (existing pattern).
8. **Block on concurrent synth:** Refuses `start()` if `book.uploading === true`. UI surfaces "Synthesis in progress, try again when it finishes."
9. **Defensive headings clear:** When the op is reductive (`isReductive(def)`), clear `chapter.headings` for each mutated chapter before `putChapters`. Avoids the pre-M10 legacy latent bug.

**Throttling:** The `onChunkStreamed` callback fires on every SSE token batch (~50ms cadence). Wrap the state update in a rAF coalescer — keep the latest `streamingBlock.text`, flush on next frame. This caps React state updates to ~60fps regardless of token rate.

---

### Phase 4 — `transformJob` persistence + boot sweep extension [resilience, M, medium risk]

**Files:**
- `web/src/types.ts` — `Book.transforming?: boolean`, `Book.transformJob?: PersistedTransformJob`
- `web/src/lib/db.ts` — `patchTransformJob(bookId, partial)`, `clearTransformJob(bookId)`, `clearTransformingFlag(bookId)` (mirror existing upload-job helpers)
- `web/src/lib/upload/boot-sweep.ts` — add `reconcileInterruptedTransforms()` (separate function; runs after `reconcileInterruptedUploads`)
- `web/src/lib/upload/boot-sweep.test.ts` — +transform cases
- `web/src/main.tsx` — invoke both sweeps before `createRoot().render()` (preserve ordering — uploads first, transforms second)

**`PersistedTransformJob` shape:**

```ts
export interface PersistedTransformJob {
  ops: TransformOp[]
  voiceId: VoiceId
  cleaning: CleaningConfig
  currentOpIndex: number
  currentChapterIndex: number
  currentChunkIndex: number
  done: number       // chunks completed (UI progress)
  total: number      // total chunks (UI progress)
  pausedAt: number
}
```

**Boot sweep rules:**

```
For each book where transforming === true at boot:
  - If book.transformJob exists → convert to paused (delete book.transforming, keep book.transformJob)
  - Else (legacy edge) → clear book.transforming, leave book alone
Never cascade-delete. Never auto-resume.
```

**Why separate function:** Different fields, different recovery rule, easier to test in isolation. The two sweeps are independent — order doesn't matter for correctness, but uploads-first matches existing expectations.

---

### Phase 5 — Wire generation mode into reader [UI, M, low risk]

**Files:**
- `web/src/routes/reader/ReaderView.tsx` — accept a `generation?: GenerationMode` prop. When set, each chapter renders its committed paragraphs normally + a `<StreamingBlock>` for the currently-streaming chunk (boxed style, no paragraph semantics). Past chapters render normally (committed). Future chapters render with a subtle "pending" wash.
- `web/src/routes/reader/ReaderPane.tsx` — instantiate `useBookTransform`, pass `generation` prop, render sticky header chip with progress + Pause/Stop buttons, gate Play button on `!book.transforming && !book.transformJob`, handle Esc-to-abort (extend existing).
- `web/src/routes/reader/ReaderView.test.tsx` — +generation-mode render tests

**Sticky header chip during running:**

```
╭──────────────────────────────────────────────────────────╮
│ ❯ cleanup · ch 3/12 · chunk 8/47 · 18%    [Pause] [Stop] │
╰──────────────────────────────────────────────────────────╯
```

**Pause / paused state:** Reader shows banner "Generation paused — ch 3/12 · 18%   [Resume] [Cancel]" in place of the streaming chip. Play button stays disabled.

**Esc-to-abort extension:** Existing Esc handler in ReaderPane closes modal first, falls through to Stop-stream second. Extend the "second" to also Stop whole-book generation.

**Scroll behavior:** When `running.streamingBlock` updates, auto-scroll the block into view (extend existing `activeParagraphRef` mechanism — point it at the streaming block).

---

### Phase 6 — Library + reader entry points [user flow, S, low risk]

**Files:**
- `web/src/routes/library/LibraryCard.tsx` (or wherever "Transform" menu action lives) — on click, navigate to `/reader/<id>?generate=1`. The reader's mount effect detects the query param and auto-opens the op-picker sheet.
- `web/src/routes/library/LibraryCard.tsx` — when book has `transformJob` (any state), badge the card: "Generation paused — Resume" (clicking the badge routes to reader with `?resume=1`).
- `web/src/routes/reader/GenerationConfirmSheet.tsx` (NEW) — modal/bottom-sheet that shows: selected op(s), chapter count, paragraph count, provider name, estimated API calls (≈ chapter count × op count for chunked approach), and a "Start" button. This is the consent gate per the Manual trigger decision.

---

### Phase 7 — Tests + manual verification [S → M, low risk]

**Unit:**
- `useBookTransform.test.ts` — start/pause/resume/cancel/retry happy paths; LLM failure → error state; concurrent-synth block; defensive headings clear on reductive op; rAF throttle keeps updates bounded
- `runner.test.ts` — `onChunkStreamed` fires per token batch + at chunk completion with `isFinal: true`; chunkIndex/chunkTotal/chunkStartInputIndex correct across multiple chunks
- `boot-sweep.test.ts` — `reconcileInterruptedTransforms` converts `transforming===true` to paused; never cascade-deletes; legacy edge clears flag only
- `StreamingBlock.test.tsx` — paragraph mode (F8) and chunk-box mode (M13) both render correctly
- `ReaderView.test.tsx` — generation mode renders committed paragraphs + one streaming block; future chapters show pending state

**Integration:**
- `ReaderPane.test.tsx` (extend) — Play button disabled when `transformJob` present; Esc aborts; resume from paused state continues correctly

**Manual via MCP:**
- Point at OpenAI-compatible endpoint
- Use a small test book (~5 chapters, ~20 paragraphs)
- Watch chapters stream sequentially with the boxed block visual
- Test Pause mid-chunk → in-flight chunk discarded, completed chunks persist
- Test tab close mid-generation → reopen → book shows "Generation paused — Resume"
- Test Cancel → already-committed chapters stay, transformJob cleared, Play re-enabled
- Test reductive op (Summarize) → paragraph count visibly shrinks at chunk end; outline nav still works

## Rough effort

| Phase | Effort | Risk                                              |
| --- | --- | --- |
| 1. Extract `<StreamingBlock>` | XS | Low — pure refactor                              |
| 2. `onChunkStreamed` callback  | S  | Low — additive                                   |
| 3. `useBookTransform` hook     | L  | Medium — biggest piece                           |
| 4. Persistence + boot sweep    | M  | Medium — mirrors existing upload-job pattern     |
| 5. Wire UI into reader         | M  | Low — extends existing patterns                  |
| 6. Entry points + confirm sheet | S  | Low                                              |
| 7. Tests + manual              | M  | Low                                              |

**Total: ~M-sized milestone**, comparable to M6 (AI transforms) or M8 (audio cache).

## Validation gates

- `pnpm verify` (lint + typecheck + test + build) — must stay green
- All new tests pass; existing 799 tests stay green
- Real-device iOS test (hard gate per ADR-0011 precedent) — stream a multi-chapter book on iPhone, verify wake lock holds, verify pause/resume survives tab suspension
- MCP browser test — point at real OpenAI-compatible endpoint, watch streaming block, test Stop/Pause/Resume

## Open implementation notes (not blockers)

1. **rAF throttle:** Use `requestAnimationFrame` to coalesce `streamingBlock.text` updates; cancel on chunk boundary. Keep `cancelAnimationFrame` in cleanup. Test the throttle via fake timers.

2. **Provider cost estimation:** Rough heuristic only — `paragraph_count × avg_tokens_per_paragraph ÷ 1000 × price_per_1k_tokens`. Mark as "estimated" in UI. Accurate accounting would require post-hoc `usage` parsing from the SSE stream (already collected but not surfaced); deferred.

3. **Outline nav during generation:** Reader's chapter nav (`Outline.tsx`) remains enabled. Navigating to a future chapter during generation shows that chapter's original (un-transformed) text with a "pending" wash. Navigating to a past chapter shows committed (transformed) text. The streaming block stays docked in the active chapter.

4. **Mobile synthesis lockdown interaction:** If `uploadManager` is mid-synth on book X and user tries to start a transform on book X → block. If user tries to start synth on book X while transform is running → also block (the `uploadManager.startJob` call from the hook's `done` state already serializes via `runningRef`, but cross-instance coordination needs a check on `book.transforming` in `uploadManager.startJob`).

5. **Cost/time preview accuracy:** The "estimated API calls" shown in the confirm sheet assumes chunked = ~1 call per chapter per op. The actual chunk count depends on `chunksForParagraphs` token budgeting; we won't know the exact chunk count until we run the chunker. UI text: "≈ 12 API calls (one per chapter)" — accurate for typical books, off by 2-3× for very long chapters.
