# Spike: Reuse the phonemize Emscripten module across predicts

> **Status:** Scaffold (not started). Independent of ADR-0011's worker pool — combinable for compound speedup.

## Problem

`PiperSession.predictOnce` (`web/src/lib/tts/vendor/piper/session.ts:200-217`) re-instantiates the Emscripten phonemize module on **every predict call**:

```ts
private async predictOnce(text: string): Promise<Blob> {
  // ...
  const module = await this.createPhonemize({    // ← fresh module every call
    print: (data: string) => { stdoutLine = data },
    printErr: (message: string) => { stderr.push(message) },
    locateFile: (url: string) => { ... },
  })
  // ...
}
```

Each instantiation re-mounts ~18 MB of `espeak-ng-data` into MEMFS. The existing comment at `session.ts:28-30` already flags this:

> The phonemize step still instantiates a fresh Emscripten module per call (behavior-preserving vs upstream — the module re-mounts the 18 MB espeak-ng-data into MEMFS each time). Reusing a module across calls is a worthwhile optimization but changes global WASM state and is left to a separate spike.

## Goal

Keep one Emscripten module alive per `PiperSession`. Per-call work reduces to invoking `callMain([text])` on the long-lived module. Re-mount MEMFS only on voice change (which already rotates the session via `PiperEngine.sessionFor`).

## Why it matters

1. **Direct per-¶ speedup.** Emscripten module instantiation is non-trivial — the 18 MB MEMFS snapshot read + WASM compile. Reusing it should cut 10–30% off each predict (more for short paragraphs where the instantiate cost dominates).
2. **Prerequisite for any future intra-worker concurrency.** Today `predictChain` (`session.ts:111-114`) serialises `predict` calls **defensively** — partly because each call spins a fresh module, but also because we haven't audited whether re-entrant MEMFS access during instantiation is safe. Reusing the module removes the instantiation window entirely, narrowing the question to "is `callMain` itself re-entrant?" — a much smaller audit surface. If `callMain` proves re-entrant-safe (likely — it's stateless w.r.t. the previous call's input), the `predictChain` could relax and the pool could share one PiperSession across virtual workers.

## Approach

### Phase 1 — Audit

1. Read `piper-phonemize`'s Emscripten glue (`piper_phonemize.cpp` + the generated `.js`). Confirm `callMain([text])` doesn't leak state between calls.
2. Check whether the Emscripten module's `MEMFS` is touched after `init()` (i.e. only at instantiation, or also during `callMain`?).
3. Check whether `print` / `printErr` callbacks can be reset per-call without re-init (Emscripten's `Module` typically allows this via `Module.print = ...`).

### Phase 2 — Implement

1. `PiperSession.create()` instantiates the phonemize module **once**, stores it on `this.phonemizeModule`.
2. `predictOnce(text)` calls `this.phonemizeModule.callMain([...args, text])` directly; no instantiation.
3. `Module.print` / `Module.printErr` are assigned per-call via the module's runtime overrides.
4. `dispose()` releases both the ORT session AND the phonemize module.

### Phase 3 — Measure

- Bench: synthesize a 100-paragraph book with the old and new paths on desktop.
- Bench: same on iOS Safari (real device).
- Report: per-¶ mean / p50 / p95, total wall-clock, peak worker memory.

### Phase 4 — Decide on `predictChain`

- If audit + measure confirm `callMain` is safely re-entrant: relax the chain (or remove it) so a single PiperSession can have multiple predicts in flight.
- If not: keep the chain. The module-reuse optimisation still lands on its own merits; intra-worker concurrency stays blocked.

## Risks

- **MEMFS corruption.** If `callMain` mutates global Emscripten state in a way the next call depends on / is broken by, reuse will surface it. The audit is the gate.
- **`Module.print` reassignment timing.** Emscripten captures some callbacks at instantiation; others can be overridden at runtime. Need to verify which category `print` / `printErr` fall into for this build.
- **Test coverage.** The existing `session.test.ts` uses `fakePhonemizeFactory` which returns a fresh module per call. Reusing modules changes the fake setup — the test infrastructure needs an update to support a `createOrReuse` factory.

## Composability with the worker pool (ADR-0011)

Independent. Both ship separately and stack:

- Pool gives N× parallel workers.
- Module reuse gives ~10–30% per-call speedup inside each worker.
- Combined: N× × 1.2–1.3× total speedup.

Neither requires the other. Either can land first.

## Open questions

- Does Piper upstream already do this? Check `rhasspy/piper-phonemize` for any "use one module" examples.
- Are there any ORT-side analogs? (ORT's `InferenceSession` is already reused today — `session.ts:161`. The phonemize module is the only per-call WASM instantiation.)
- Worker memory ceiling: does dropping the per-call 18 MB MEMFS snapshot let us safely bump iOS pool size from 2 to 3?

## Next steps

1. Read `piper-phonemize` Emscripten source.
2. Audit `callMain` re-entrancy.
3. Prototype the reuse path in `spike/` (new throwaway spike app, mirroring `spike/piper/`).
4. Benchmark vs baseline.
5. If positive: ADR + production PR.
