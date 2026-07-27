# ADR-0011: Parallel synthesis via a bounded worker pool

- **Status:** Accepted (verified 2026-07-19 on iPhone + desktop)
- **Date:** 2026-07-19
- **Companions:** [`0006-mobile-mse-streaming.md`](./0006-mobile-mse-streaming.md) (COOP/COEP rejection — why we don't use ORT threads), [`0009-upload-wake-lock-and-boot-sweep.md`](./0009-upload-wake-lock-and-boot-sweep.md) (resume contract preserved), [`0010-playback-engine-architecture.md`](./0010-playback-engine-architecture.md) (pluggable engines — pool is pre-synth only, playback stays singleton)

## Context

Pre-synthesis — the `preSynthesizeBook` phase of upload that runs Piper over every paragraph and writes WAVs into the M8 `audioCache` — is the wall-clock-dominant stage of upload. A 7-hour book (~3000 paragraphs at ~5s per synth) takes ~4 hours to pre-synth. The user waits.

Today every layer is strictly sequential:

- **`preSynthesizeBook`** (`lib/pre-synth.ts`) — `for...of await` over paragraphs.
- **`PiperSession`** (`lib/tts/vendor/piper/session.ts`) — `predictChain` serialises `predict` calls inside one session, deliberately guarding Emscripten MEMFS re-entrancy.
- **One singleton worker** (`lib/tts/client.ts`) — one resident Piper model, one in-flight predict at a time.

The line `ort.env.wasm.numThreads = navigator.hardwareConcurrency` at `session.ts:126` is **effectively a no-op in production**. ORT pthreads require `SharedArrayBuffer`, which requires cross-origin isolation (COOP/COEP) headers, which the project has rejected repeatedly (M2, M3, ADR-0006) for the "any static host works (incl. GitHub Pages)" property. ORT is also hard-pinned to `1.18.0` (gotcha #1 — `@mintplex-labs/piper-tts-web` hardcodes the ORT wasm URL to cdnjs@1.18.0; any other version deadlocks inference).

Intra-worker concurrency is blocked independently of ORT: the phonemize Emscripten module's MEMFS is global per worker. The `predictChain` Promise chain in `PiperSession.predict` is the explicit guard against re-entrant MEMFS corruption. Removing it safely is a separate future effort (audit `callMain` re-entrancy).

What **is** cleanly parallelisable: multiple Worker realms, each with its own `PiperEngine` + `PiperSession` + resident ORT session + phonemize MEMFS. The IDB audio cache is content-addressed (`voiceId:normVersion:sha256(text)`) and shared across workers, so two workers writing different paragraphs never conflict. `returnAudio: false` (already used by the upload pipeline) keeps WAVs in-worker — no main-thread structured-clone round-trip per paragraph.

## Decision

### 1. New `PoolEngine` — pre-synth only

`lib/tts/pool.ts` adds a `PoolEngine implements TtsEngine` that owns N Workers (each running `tts.worker.ts`) and dispatches `synthesize` calls least-busy.

```ts
class PoolEngine implements TtsEngine {
  constructor(readonly concurrency: number, voiceEngine: TtsEngine, opts?: PoolEngineOptions)
  synthesize(req): Promise<SynthesisResult>  // pool-backed
  // listVoices / isStored / download / remove / clearAllStored → delegate to voiceEngine
  dispose(): void
}
```

Voice management (`listVoices`, `isStored`, `download`, `remove`, `clearAllStored`) **delegates to the singleton `ttsClient`**. The pool never coordinates downloads — each lazy-spawned worker's `PiperEngine` loads its model from OPFS on first synth, and the upload pipeline pre-downloads the voice via the singleton before pre-synth starts. In the normal flow every worker hits OPFS instantly; only cold-first-use pays one HF fetch per worker.

Reader/playback and Settings → voice-picker keep using the singleton `ttsClient` unchanged. Playback is cache-hit driven and low-QPS — no benefit from a pool, and voice-download coordination stays simple.

### 2. Lazy spin-up + least-busy dispatch

- **Lazy**: pool starts empty; each dispatch either uses the least-busy existing worker or grows the pool by 1 up to `concurrency`. The first N dispatches pay the cold `InferenceSession.create` (~4s) concurrently. Idle workers never spawn.
- **Least-busy**: `argmin(slot.pending)` across non-failed slots. Cache hits (`synthMs === 0`) return near-instantly; least-busy absorbs the variance, keeping the window full.

### 3. Platform-aware sizing — `lib/tts/pool-size.ts`

```ts
preferredPoolSize() = isMobileDevice() ? 2 : min(navigator.hardwareConcurrency ?? 4, 8)
```

- **Mobile = 2.** iOS Safari's per-tab worker memory budget is the ceiling. Each resident Piper model is ~63 MB plus the per-call Emscripten MEMFS snapshot (~18 MB espeak-ng-data). A pool of 2 is the largest size that doesn't reliably OOM under typical mobile conditions. ≈2× speedup is also where it matters most: mobile CPUs are slower and the FFmpeg whole-book encode is gated on a 200 MB cap that long books exceed.
- **Desktop = `min(hc, 8)`.** ORT predict is CPU-bound single-threaded WASM, so one worker per logical core maximises throughput up to a sane cap. ≈4–8× speedup expected.

### 4. `preSynthesizeBook` gains a `concurrency` option

The caller-level `for...of await` was the actual bottleneck — adding a pool without changing the loop would leave one in-flight synth at a time, making the pool useless. `PreSynthOptions` now takes `concurrency` (default `1` = bit-for-bit sequential behaviour preserved). With `concurrency > 1`, the loop fills a bounded window:

```ts
while (nextDispatch < total || inflight.length > 0) {
  while (!signal?.aborted && inflight.length < concurrency && nextDispatch < total) {
    inflight.push({ flatIndex: nextDispatch++, promise: dispatchOne(flatIndex) })
  }
  if (inflight.length === 0) break
  const settled = await Promise.race(inflight.map(...))
  // remove settled, handle ok/err, onProgress(done, total, completed)
}
```

`onProgress` gains an optional 3rd arg `completed?: ParagraphLocation` — the paragraph that just finished, since out-of-order completion under `concurrency > 1` means we can no longer infer it from the previously-fired `onParagraphStart`. The manager wires this directly into the per-¶ `uploadJob` patch (replacing the old `peekCurrentLocation()` heuristic).

`paragraphs[i]` (the return value consumed by `encodeBook`) stays **flat-indexed** — the array is pre-allocated to `flat.length` and entries are assigned by index regardless of completion order. The `done` counter is monotonic by construction (incremented once per resolved entry under single-threaded JS).

### 5. Abort semantics unchanged

In-flight Piper predicts cannot be interrupted (ORT 1.18.0 limitation — gotcha #18). With concurrency, abort means:

- No new dispatches (the inner `while` checks `signal?.aborted`).
- In-flight synths drain to completion; their results land in the M8 cache — pure benefit for the eventual resume.
- The 90s per-¶ timeout (`SYNTH_TIMEOUT_MS`) still catches frozen workers.

This preserves ADR-0009's pause/resume contract: a paused book has `uploading = false` with a persisted `uploadJob`, and `resume()` reloads chapters, re-runs the spec, and the cache fast-forwards through everything already completed (in any order — the cache is content-addressed, not index-addressed).

### 6. Per-worker failure recovery

A worker that fires `error` or returns a fatal `workerError` (`NotFoundError`, `InvalidStateError`, `DataError`, `InternalError` — same allowlist as the singleton client) is terminated, its in-flight requests rejected, and the slot marked `failed`. The next dispatch that would target a failed slot re-spawns it (terminate + create a fresh Worker). Non-fatal `workerError` (e.g. `PARSE_ERROR` noise) is logged but does not fail the slot — predict typically still succeeds, matching the singleton's behaviour.

The singleton client recovers from fatal errors via an in-place `resetEngine` (cheap when it works, ~4s model reload). The pool deliberately takes the heavier "terminate + respawn" path because per-slot reset coordination adds complexity for negligible benefit — fatal errors are rare (the user's logs show `PARSE_ERROR` is the common case, which is non-fatal), and the cost is one ~4s reload per fatal event.

## Consequences

- **Mobile upload ≈ 2× faster**; **desktop upload ≈ 4–8× faster**. The full speedup lands only on real hardware — jsdom can't measure it.
- **iOS memory pressure is the gating risk.** Pool size 2 is the documented safe ceiling, but real-device verification was a hard gate before this hit production (passed 2026-07-19 on iPhone — see Validation gates). A worker that OOMs is recovered via the fatal-error path (terminate + respawn), but repeated OOMs under sustained mobile memory pressure would thrash — the recovery is best-effort, not a guarantee.
- **Cold-start cost unchanged for the first paragraph.** Lazy spin-up means worker 0 pays the same ~4s model load as before. Workers 1..N pay it concurrently on their first dispatch — net faster than sequential even on cold start.
- **Resume contract unchanged.** ADR-0009's `done` counter remains monotonic; the M8 cache is content-addressed so out-of-order completion doesn't desync resume. The persisted `lastFlatIndex` / `lastChapterTitle` / etc. fields are UI-display-only (per `types.ts`), so reflecting the most-recently-completed paragraph rather than the last contiguous one is fine — both are accurate "where the user got to" hints.
- **Reader/playback path is untouched.** The singleton `ttsClient` keeps its one-worker model; the reader's cache-miss re-synth path, the per-¶ look-ahead, and the Settings voice picker are all unchanged. No risk to the playback hot path.
- **Future: phonemize module reuse** (composable, not required). The comment at `session.ts:28-30` already flags this as a worthwhile optimisation — keeping one Emscripten module alive across predicts instead of re-instantiating per call. It's independent of the pool (speeds up every predict, in any worker) and is a prerequisite for any future intra-worker concurrency. Tracked as a future effort, not yet scoped.

## Out of scope

- **COOP/COEP deployment mode** for ORT pthreads (still rejected — would break GitHub Pages hosting).
- **Pool for reader/playback** (no measurable benefit; playback is cache-driven and low-QPS).
- **Auto-resume on boot** (still rejected per ADR-0009).
- **Intra-worker concurrency** (needs the phonemize-module-reuse spike first; MEMFS re-entrancy is unresolved).

## Validation gates

- `pnpm verify` (lint + typecheck + test + build) — ✅ passes modulo pre-existing lint errors in unrelated test files.
- `pool.test.ts` (11 tests) — ✅ covers lazy spin-up, least-busy dispatch, cap behaviour, fatal/non-fatal workerError, crash recovery, abort, dispose.
- `pre-synth.test.ts` (14 tests, +4 new) — ✅ covers out-of-order `paragraphs[i]` alignment, monotonic `done` counter, `concurrency=1` bit-for-bit backward compat, abort-with-in-flight semantics.
- Existing upload + library integration tests — ✅ all 911 pass (with the pool mocked as a passthrough to `ttsClient`).
- **Real-device iOS test (hard gate)** — ✅ **Passed 2026-07-19.** Verified on a real iPhone: synthesize a >200-paragraph book with pool size 2 (no OOM crash), correct M8 audio cache record count afterward, and resume-after-pause continues from the correct location. Desktop also verified.
