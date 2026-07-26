# SPEC — M13: Whole-Book Streaming AI Transform

> **Status:** 🚧 In progress — parallel phase (named-phase variant; M11 is canonical current).
> Plan: [`tasks/plan-m13-whole-book-streaming-transform.md`](../tasks/plan-m13-whole-book-streaming-transform.md) ·
> Decisions: [`docs/adr/0012-whole-book-streaming-transform.md`](../docs/adr/0012-whole-book-streaming-transform.md) ·
> Resume precedent: [`docs/adr/0009-upload-wake-lock-and-boot-sweep.md`](../docs/adr/0009-upload-wake-lock-and-boot-sweep.md) ·
> Synth pause/resume precedent: [`docs/adr/0010-playback-engine-architecture.md`](../docs/adr/0010-playback-engine-architecture.md).
>
> **Deviation note:** the harness expects exactly one current `SPEC.md` + `tasks/plan.md`. M11 holds those slots. M13 is an explicit, non-accidental named-phase deviation (`spec/<name>.md` + `plan-<slug>.md`) because both phases are genuinely in-flight. When M11 ships, M13 either becomes canonical or ships on its own.

## Problem

Today's whole-book AI transform (`useAiTransform` in `routes/library/useAiTransform.ts`) runs **invisibly**: a single `fraction` progress bar, no token-level feedback, no per-paragraph visual. For a 300-paragraph book the user stares at a spinner for 5+ minutes while the LLM churns. The just-shipped per-paragraph stream (F8 in the reader) is the right visual — but it only rewrites one paragraph at a time, on user click.

We want the **ChatGPT / Claude Code effect for the whole book**: user picks op(s), watches each chapter's paragraphs rewrite token-by-token in place, in the actual reader pane. The book visibly *becomes* the AI version.

## Decisions (locked)

| Area | Decision |
| --- | --- |
| Trigger | **Manual**, from library/reader entry points. Existing `useAiTransform` pattern kept for non-visual contexts (re-process flow). |
| Visual surface | **Reader paragraphs replaced in place.** Reader switches to "generation mode"; the book visibly becomes the AI version. |
| LLM call granularity | **Per-chapter, multi-paragraph chunks.** Reuses `chunksForParagraphs` token-budget chunker. ~1 chunk per chapter for typical books, more for long chapters. |
| Streaming visual | **One boxed "streaming block" per active chunk** — Claude-Code style. Token-by-token inside the box; when chunk completes, text snaps into proper paragraph slots and the next chunk's box opens below. Uniform across all op types. |
| TTS coordination | **Sequential.** AI finishes → `uploadManager.startJob({mode:'resynth'})` as today. No concurrent synth during generation. |
| Persistence | **Resume on next open via `Book.transformJob`.** Mirrors `Book.uploadJob` pattern (ADR-0010, gotcha #24). |
| Playback during transform | **Blocked.** While `transformJob` exists (any state), the reader's Play button is disabled. User must Resume to completion or Cancel. Mirrors `uploading: true` behavior. |
| Pause / interrupt | **Explicit Pause + auto-convert-to-paused on tab close/crash.** Boot sweep extended (ADR-0009 revised rule). |
| Reductive ops (Summarize) | **Batch-replace at chunk end.** No live per-paragraph ID mutation. Positional paragraph IDs re-derive on every flatten; chapter-level outline nav unaffected. |
| Legacy `Chapter.headings` | **Defensive clear on reductive ops.** Pre-existing latent bug in `useAiTransform` not addressed; M12 will not inherit it. |
| Wake lock | **Acquired on `start()`/`resume()`, released on Pause/Done/Error/Cancel.** Best-effort, never fatal (ADR-0009). |

## Architecture

```
web/src/
  lib/
    ai/
      types.ts                   — AiTransformEngine.transform += onChunkStreamed
      runner.ts                  — runTransform forwards onChunkStreamed per chunk
      runner.test.ts             — +tests for onChunkStreamed
    upload/
      boot-sweep.ts              — reconcileInterruptedTransforms() (new sibling)
      boot-sweep.test.ts         — +transform cases
    db.ts                        — patchTransformJob / clearTransformJob helpers
    types.ts                     — Book.transforming, Book.transformJob fields
                                    PersistedTransformJob interface
  routes/
    reader/
      StreamingBlock.tsx         — NEW: presentational chunk-stream box (extracted
                                    from current ReaderView per-paragraph stream)
      StreamingBlock.test.tsx    — NEW
      ReaderView.tsx             — generation prop renders StreamingBlock per chapter
      ReaderView.test.tsx        — +generation-mode tests
      ReaderPane.tsx             — instantiates useBookTransform, gates Play,
                                    renders generation banner (Pause/Resume/Cancel)
      useBookTransform.ts        — NEW: state machine + LLM driver, exposes
                                    start/pause/resume/cancel/retry
      useBookTransform.test.ts   — NEW
      Outline.tsx                — (no change — positional nav is already safe)
    library/
      LibraryCard.tsx            — "Transform" menu action → routes to reader
                                    in generation mode with op-picker armed
      GenerationConfirmSheet.tsx — NEW: pre-flight cost/chapter-count confirm
  components/
    GlobalUploadBanner.tsx       — (no change — generation banner is reader-local)
  context/settings.tsx           — (no change)
```

### State machine (mirrors ADR-0010 §24 / gotcha #24)

```
                       user clicks Pause
                       ┌──────────────────┐
                       │                  │
                       ▼                  │
  idle ──► running ────┤  (transforming=false)
                       │                  │
                       │ tab close/crash  │
                       │ (transforming     │
                       │  stays =true)    │
                       │                  │
                       ▼                  │
                 interrupted              │
                       │                  │
                       │ boot sweep       │
                       │ (next open)      │
                       ▼                  │
                 paused ──────────────────┘
                       │
                       │ user clicks Resume
                       ▼
                 running ──► done / error
```

**Load-bearing detail (same as gotcha #24):** a paused transform has `transforming: false`. The boot sweep **only** acts on `transforming === true` (truly interrupted). Explicit user-pause is invisible to the sweep.

## Non-goals (this milestone)

- **Concurrent synthesis during generation** — AI finishes, then `uploadManager.startJob({mode:'resynth'})` runs sequentially (existing pattern).
- **Accurate cost accounting** — the confirm sheet shows an estimate only; precise usage parsing from SSE is deferred (see plan's Open notes).
- **Live per-paragraph ID mutation for reductive ops** — reductive ops batch-replace at chunk end; paragraph IDs re-derive on flatten.
