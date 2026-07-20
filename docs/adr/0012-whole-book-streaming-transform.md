# ADR-0012: Whole-book streaming AI transform

- **Status:** Accepted (in progress)
- **Date:** 2026-07-19
- **Revised:** 2026-07-20 (Decision 3 superseded — see "Revision 2026-07-20" below)
- **Companions:** [`0009-upload-wake-lock-and-boot-sweep.md`](./0009-upload-wake-lock-and-boot-sweep.md) (resume contract precedent — revised rule), [`0010-playback-engine-architecture.md`](./0010-playback-engine-architecture.md) (synth pause/resume precedent — gotcha #24), [`0011-parallel-synthesis-pool.md`](./0011-parallel-synthesis-pool.md) (pool stays pre-synth only — M13 doesn't widen it), [`0008-pdf-structure-extraction.md`](./0008-pdf-structure-extraction.md) (outline navigation stays positional — paragraph identity is index-based, not text-based)

## Revision 2026-07-20 — In-place streaming (supersedes Decision 3)

**Original Decision 3** chose a uniform boxed chunk-stream visual (`<StreamingChunkBlock>`) docked at the active chapter's tail, on the premise that per-paragraph live renumbering would risk audio-cache/bookmark/outline integrity.

**Empirical finding (first real-user test):** with a single-chunk, full-chapter stream (218 paragraphs, OpenRouter free tier), the chunk-box accumulated 47K chars off-screen below 218 unchanged paragraphs for 79 seconds. The user saw only a stuck `0%` banner and assumed the stream was broken. The chunk-box design provided zero visible progress in the common single-chunk case.

**On inspection, the original risk argument was overcautious:**
- **Audio cache** (`lib/audio-cache.ts`) is content-addressed by paragraph text hash. The streaming visual doesn't touch the cache; only chapter commit does (unchanged). No risk.
- **Outline / bookmarks** use positional IDs (`${chapterId}:${index}`). Non-reductive ops preserve paragraph count → IDs stay valid throughout the stream. Reductive ops already replace the whole chapter at commit (count changes regardless of streaming visual).
- **Player** is blocked during generation (Decision 7, unchanged) → no half-state playback.

**New approach — in-place streaming with mode-aware rendering:**

The manager now parses the cumulative streamed text via `splitOutput(info.textSoFar)` on every throttled emit (250ms) and emits `streamingParagraphs: { paragraphs: string[], isReductive, chunkStartIndex, chunkInputCount, ... }` instead of `streamingBlock: { text }`.

`ReaderView` renders the parsed paragraphs in the chapter's slots:
- **Preserve mode** (`isReductive === false`, e.g. cleanup/simplify/pronunciation-hints): the chapter's existing slots are kept; streaming paragraphs overwrite them one-by-one starting at `chunkStartIndex`. The last streamed paragraph is marked `streaming` (gets the `█` cursor and `tt-streaming` accent border). Slots past the streamed range render their original text **dimmed** (`opacity-50`) so the user sees what's still pending. Slots before `chunkStartIndex` (committed by a previous chunk) render normally.
- **Replace mode** (`isReductive === true`, e.g. summarize): the chapter's original paragraphs are hidden entirely; only the streaming paragraphs render, last = cursor. The chapter visually "collapses then grows" — ChatGPT-summarize style. Synthetic IDs (`${chapter.id}:stream:N`) are used because slot indices will change at commit anyway.

The `<StreamingChunkBlock>` component was removed (dead code). `StreamChip` and `StreamingCursor` stay — they're reused for both F8 per-paragraph streaming and the M13 in-place visual.

**Banner progress is now sub-chapter.** The generation banner folds chunk fraction into the percentage: `fraction = (done + (chunkIndex + intraChunk)/chunkTotal) / total` where `intraChunk = min(1, paragraphs.length / chunkInputCount)`. A 218-paragraph single-chunk stream now visibly climbs from 0% to ~100% over the chapter duration instead of sitting at 0% the whole time.

**Preparing state** (running but no tokens yet) gets a spinner + live `Ns elapsed` counter in both the banner and an inline chip docked at the active chapter. Without this, the user can't distinguish "model is doing prefill" from "app is hung" — critical for slow-prefill providers like glm-4.7 on z.ai's free tier (measured 268s TTFB on 2026-07-20).

**Reasoning token surfacing** — reasoning models (glm-5.2, DeepSeek-R1, OpenAI o1 via OpenRouter, Anthropic thinking) emit prefill+thinking tokens in a *separate* SSE field (`delta.reasoning_content` for DeepSeek/z.ai, `delta.reasoning` for OpenRouter) BEFORE producing visible output. We previously discarded these (`sse.ts` only read `delta.content`) — the user saw nothing for tens of seconds while the model was actively thinking. The SSE parser now extracts both fields; `consumeSse` takes an optional `onReasoning` callback; the runner threads reasoning into `ChunkStreamInfo.reasoningSoFar`; the manager stores it in `streamingParagraphs.reasoning`; the preparing chip renders the last ~200 chars of live reasoning under a "thinking" sub-label. Once content paragraphs begin arriving, the reasoning snippet is hidden and in-place streaming takes over. Non-reasoning models (gpt-4o, claude-haiku, glm-4.7) never emit the field — zero regression, the callback simply doesn't fire.

**Chunk-size cap** (`UX_MAX_CHUNK_TOKENS = 2000` in `chunk.ts`). Even when the model's context window could fit more, per-chunk input is capped so prefill latency stays tolerable. Without the cap, a 128K-context model receiving a 12K-token chapter produces ONE chunk, and the user waits the model's full prefill time before any token streams. With the cap, the chapter splits into ~6 chunks; each chunk's prefill is faster and the first chunk streams within seconds. Total wall-clock time is similar (same model work overall), but perceived latency drops dramatically. Trade-off: more LLM calls (no cost on free tiers, slight cost on paid). If a reductive op's quality regresses (summarize loses chapter-wide context), promote the cap to a `TransformDefinition.chunkBudgetTokens` field so op types can opt into a larger budget.

**Surplus handling (rare):** if a non-reductive model outputs more paragraphs than the chunk's input count (off-script for cleanup/simplify), the surplus is appended as in-progress slots after the chunk's range. At commit, the runner already drops surplus (`runner.ts: max = Math.min(parts.length, chunk.paragraphs.length)`), so streaming and commit stay consistent.

**Tradeoff accepted:** layout may shift during streaming as paragraphs grow/shrink per 250ms tick. React's reconciliation handles text changes cheaply; CSS transitions on height are optional future polish. The UX win (visible progress, ChatGPT-style feedback) outweighs the minor reflow.

## Context

The whole-book AI transform shipped in M6 (`useAiTransform`, `routes/library/useAiTransform.ts`) is the only path that rewrites every paragraph of a book. It runs **invisibly**: a single aggregate `fraction` progress bar, no token-level feedback, no per-paragraph visual. For a 300-paragraph book the user stares at a spinner for 5+ minutes.

M13's per-paragraph streaming (`useParagraphTransform`, just shipped) proved the visual the user actually wants: ChatGPT / Claude Code style — watch each paragraph rewrite token-by-token in place, in the actual reader pane. The book should visibly *become* the AI version.

This ADR records the decisions for extending that visual to the **whole book**.

## Decision

### 1. Manual trigger, in-reader generation mode

User picks a book, picks op(s), picks Start. No auto-on-upload — explicit consent for API spend, matches existing `useAiTransform` pattern. Generation renders **in the reader pane** (not a separate route, not a modal): the book's paragraphs replace in place as the model streams. The reader visibly transforms from the original into the AI version, chapter by chapter.

Rejected: auto-on-upload (silent spend), separate `/generate/<id>` route (two surfaces to maintain), modal overlay (loses the "book becomes the AI version" effect).

### 2. Per-chapter chunked LLM calls, reusing `engine.transform`

One LLM call per token-budget chunk, multiple paragraphs per chunk, multiple chunks per chapter for very long chapters. Reuses `chunksForParagraphs` and the existing `runTransform` machinery — no new LLM call shape, no new provider contract.

Rejected: per-paragraph LLM calls (1000+ calls for a novel — slow, expensive, rate-limit risk); whole-book single call (infeasible for novels at 128k–200k token provider caps).

### 3. ~~One boxed streaming block per active chunk (uniform visual)~~ — SUPERSEDED

> **Superseded 2026-07-20** — see "Revision 2026-07-20" above. The chunk-box visual was replaced with **in-place streaming** (preserve mode for non-reductive ops, replace mode for reductive). The chunk-box component (`<StreamingChunkBlock>`) was deleted; the chunk stays the atomic streaming unit internally but is no longer a user-visible concept.

During a chunk's stream, the reader renders one **boxed streaming block** docked at the chunk's first paragraph position. Token-by-token text grows inside the box; a blinking `█` cursor trails; a chip shows `❯ {opLabel} · chunk N/M ■ Stop`. When the chunk completes, `splitOutput` runs, the box disappears, and the resulting paragraphs snap into their proper slots (`out[idx]` per `runner.ts:105-127`). The next chunk's box opens below.

This visual is **uniform across all op types** — cleanup, simplify, summarize, translate, pronunciation hints all look the same. The chunk is the atomic streaming unit. Within a chunk we don't try to identify paragraph boundaries mid-stream — that would require live paragraph-ID mutation (risky for audio cache, bookmarks, outline nav).

Rejected: per-paragraph live streaming for non-reductive ops + chunk-blob for reductive (op-aware branching, more code, inconsistent UX); per-paragraph live streaming for all ops (reductive ops would visibly collapse/merge paragraphs mid-stream, paragraph IDs mutate, audio-cache/bookmark/outline risk).

### 4. Sequential AI → TTS, not concurrent

AI generation runs to completion, then `uploadManager.startJob({mode:'resynth'})` kicks off as today. No concurrent synthesis during generation. Two distinct phases.

Rejected: concurrent per-paragraph synth (complex coordination — M8 cache invalidation racing with the next token, double-active-job state, mobile lockdown becomes ambiguous).

### 5. Resumable via `Book.transformJob` (mirrors `Book.uploadJob`)

```ts
interface PersistedTransformJob {
  ops: TransformOp[]
  voiceId: VoiceId
  cleaning: CleaningConfig
  currentOpIndex: number
  currentChapterIndex: number
  currentChunkIndex: number
  done: number
  total: number
  pausedAt: number
}
```

`Book.transforming?: boolean` + `Book.transformJob?: PersistedTransformJob` (IDB schemaless — no DB version bump, same precedent as `uploadJob` from ADR-0010 §24). Write-from-first-tick rule (ADR-0009 gotcha #18): the spec is persisted on `start()` before the first LLM call, so any interruption leaves a resumable state.

**Load-bearing detail (mirrors gotcha #24):** an explicitly-paused transform has `transforming = false`. The boot sweep **only** acts on `transforming === true` (truly interrupted — tab close, crash, OS kill). Explicit user-pause is invisible to the sweep. The chunk that was mid-stream when interrupted is **re-sent from scratch** on resume — chunks only commit at their boundary, so no half-state needs reconciliation.

### 6. Boot sweep extended with `reconcileInterruptedTransforms`

Separate function from `reconcileInterruptedUploads` (different fields, different recovery rule, easier to test in isolation). Runs after the upload sweep in `main.tsx` before `createRoot().render()` (same ordering rationale — eliminates the race where a user opens a stale URL the sweep is about to mutate).

Rules (mirrors ADR-0009 revised recovery rule, never cascade-deletes):
- `transforming === true` + `transformJob` exists → convert to paused (delete `transforming`, keep `transformJob`)
- `transforming === true` + no `transformJob` (legacy edge from pre-M13 code) → clear `transforming`, leave book alone
- **Never cascade-delete. Never auto-resume.**

### 7. Playback blocked while `transformJob` exists

Reader's Play button disabled when `book.transforming === true` OR `book.transformJob` exists (any state — running, paused, error). User must Resume to completion or Cancel. Mirrors the existing `book.uploading` gate (mobile synth lockdown, ADR-0010 §24).

Rationale: the M8 audio cache is content-addressed by paragraph text hash. During a partial transform, already-committed paragraphs cache-miss (correct, re-synth on demand); un-transformed paragraphs cache-hit on **old** text and play **old** audio (confusing). Blocking playback eliminates the half-state. Once the transform completes, `useBookTransform`'s `done` state purges the book's audio (same as `useAiTransform.ts:205-217`) and kicks re-synth.

### 8. Defensive clear of legacy `Chapter.headings` on reductive ops

Pre-M10 books may have `Chapter.headings` populated (sub-paragraph outline nav). The stored `paragraphIndex` values become **stale** if a reductive op (Summarize) changes a chapter's paragraph count. `useAiTransform` does not clear `headings` — pre-existing latent bug. M13's `useBookTransform` **will** defensively clear `headings` on any reductive op (one-line `delete chapter.headings` before `putChapters`). Sub-heading UI disappears for that chapter; chapter-level nav remains.

Chapter-level outline nav is unaffected by any op type. Paragraph identity is positional (`` `${chapterId}:${index}` ``) and re-derives on every flatten — text rewrites are invisible to navigation.

### 9. Wake lock + pagehide abort (mirrors ADR-0009)

`acquireUploadWakeLock()` on `start()`/`resume()`; released in `finally` of the run loop. Best-effort, never fatal — the existing handle degrades to a no-op on missing API or rejected promise. `pagehide` aborts the in-flight chunk via the run's `AbortController`; the next-open boot sweep reconciles.

## Consequences

- **Resume contract preserved.** ADR-0009 revised rule and gotcha #24 patterns are reused unchanged. A paused/interrupted transform resumes from the next chunk boundary; committed chunks survive any interruption.
- **Outline navigation stays positional.** Re-derives from `chapter.paragraphs` on every flatten; never depends on paragraph text. Legacy sub-heading nav (`Chapter.headings`) is defensively cleared on reductive ops to avoid stale-index landmines.
- **No DB version bump.** `transformJob` and `transforming` are new optional fields on `Book`; IDB schemaless.
- **No new dependencies.** Reuses `engine.transform`, `runTransform`, `chunksForParagraphs`, `uploadManager`, `acquireUploadWakeLock`, `reconcileInterruptedUploads` patterns. The `<StreamingBlock>` component is a refactor of code already in `ReaderView.tsx`.
- **`PoolEngine` (ADR-0011) stays pre-synth only.** M13 does not widen the TTS pool to AI generation. AI transforms go through the singleton AI client (single in-flight `fetch` per chunk). Parallelism here is a separate question — left out of scope.
- **Reader / playback path is untouched** during normal reading. Generation mode only activates when the user explicitly starts a transform; otherwise the reader behaves as before.
- **Mobile experience degrades gracefully.** Phone lock / tab suspension aborts the in-flight chunk; boot sweep resumes. Wake lock holds where it can; nothing fatal where it can't.

## Out of scope

- **Auto-resume on boot** (still rejected per ADR-0009 — explicit Resume only).
- **Concurrent AI + TTS synthesis** (rejected above — sequential is simpler and matches existing `useAiTransform` behavior).
- **Per-paragraph live streaming for non-reductive ops** (originally rejected above — **reversed in the 2026-07-20 revision**; in-place streaming is now the shipped behavior for both reductive and non-reductive ops).
- **Live API cost accounting** (the `usage` field is already collected in the SSE stream; surfacing it post-run is deferred).
- **PoolEngine for AI generation** (ADR-0011 stays pre-synth only; M13 does not parallelize LLM calls).
- **Re-introduction of `Chapter.headings` auto-detection** (ADR-0008 stays — pdfjs outline is the only source, AI is the only fallback; M13 just defensively clears the field when reductive ops would invalidate it).

## Validation gates

- `pnpm verify` (lint + typecheck + test + build) — must stay green
- All 799 existing tests stay green; new tests added per phase
- **Real-device iOS test** (hard gate per ADR-0011 precedent) — stream a multi-chapter book on iPhone, verify wake lock holds during stream, verify pause/resume survives iOS tab suspension
- MCP browser test — point at real OpenAI-compatible endpoint, watch streaming block visual, test Stop / Pause / Resume / Cancel paths
