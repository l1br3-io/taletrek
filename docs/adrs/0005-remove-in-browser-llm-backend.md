# ADR-0005: Remove the in-browser LLM backend

- **Status:** Accepted. *(Historical — all AI transforms were removed from the SPA by the native pivot, [`0015-native-pivot-rust-kernel-and-native-apps.md`](./0015-native-pivot-rust-kernel-and-native-apps.md).)*
- **Date:** 2026-07-14
- **Supersedes:** the in-browser half of [`0003-ai-transform-architecture.md`](./0003-ai-transform-architecture.md) (cloud backend + `AiTransformEngine` interface + ADR-0004 key handling remain in force)

## Context

M6 (ADR-0003) shipped AI transforms with **two** interchangeable backends behind one `AiTransformEngine` interface:

1. **In-browser** — `@mlc-ai/web-llm` running a Qwen2.5-1.5B model via WebGPU, cached in OPFS, in a dedicated Web Worker.
2. **Cloud** — any OpenAI-compatible HTTP endpoint, user-supplied key (ADR-0004).

The in-browser backend was the strategic default: it preserved the offline-first promise that defines TaleTrek and needed no key. In practice it carried sustained cost and risk:

- **Bundle / build surface.** `@mlc-ai/web-llm` (~6 MB per chunk) forced special-casing across the build: a `manualChunks` rule, a service-worker `globIgnores` + runtime-cache entry, and a dedicated worker entry. Every PWA/SW change had to account for the WebLLM chunks.
- **Runtime fragility.** WebGPU availability is uneven (Safari maturing, Flatpak Chromium blocking Vulkan at the sandbox, older devices). The feature-detect + fallback story added a whole error class (`WebLlmError` codes `no-webgpu` / `not-loaded` / `load-failed`) that the cloud path never has.
- **Quality ceiling.** A 1.5B model is GPT-3.5-class at best on translation/summarization — the cases where readers most want AI help are exactly where the local model is weakest. Users wanting real quality already needed the cloud path.
- **Testing burden.** WebGPU can't run in jsdom; the engine's tests relied on heavy mocking and a spike app under `spike/webllm/`, while real inference could only be verified on bare metal. The cloud engine is fully unit-testable with `fetch` mocks.
- **Model lifecycle.** Idle teardown, OPFS rehydration, and the worker protocol duplicated concerns already solved once for Piper — a second heavy ML runtime to keep warm, debug, and migrate across `@mlc-ai/web-llm` releases.

The cloud backend covers the same transforms (cleanup/translate/summarize/simplify/pronunciation-hints/outline) through the identical `AiTransformEngine` interface, with no extra dependencies (native `fetch`) and no WebGPU dependency.

## Decision

**Remove the in-browser WebLLM backend. M6 is cloud-only.**

- Delete `web/src/lib/ai/engines/webllm.ts`, `webllm.worker.ts`, `webgpu.ts` (feature-detect), and the throwaway `spike/webllm/` app.
- Drop the `@mlc-ai/web-llm` dependency and all build/SW special-casing for it (`manualChunks`, `globIgnores`, `webllm-runtime` cache, the worker entry).
- `AiSettings.backend` narrows from `'in-browser' | 'cloud'` to the literal `'cloud'`; the `inBrowser` field is removed. The `backend` field is retained as a discriminator so `migrateAi()` can read and coerce stale stored `in-browser` settings to `cloud` (keeping `enabled` as-stored).
- The `AiTransformEngine` interface, the shared `runner.ts`/`prompts.ts`/`chunk.ts`, the cloud `engines/openai.ts` + `engines/sse.ts`, and ADR-0004 (in-memory key) are **unchanged**.
- The `Settings → AI` UI loses the backend picker and the model-id input; enabling AI goes straight to the cloud provider list.

## Consequences

- **Positive:** Smaller bundle, simpler PWA/SW config, one fewer heavy ML runtime to maintain, no WebGPU feature-detect or `no-webgpu` error path, fully unit-testable AI engine, no `@mlc-ai/web-llm` upgrade treadmill.
- **Negative:** Transforms no longer work offline. This narrows M6's reach for the jog-mode / no-connectivity use case — but the on-device TTS pipeline (the core product) is unaffected and remains fully offline.
- **Migration:** A user with `backend: 'in-browser'` stored will, after upgrade, see the AI section enabled with an empty cloud provider list. They must add a provider to continue using transforms. `enabled` is preserved so the opt-in signal isn't silently flipped.
- **Reversibility:** The `AiTransformEngine` contract is intact, so a future local backend (a smaller WebGPU/WASM model, or WASI-compiled runtime) can slot back in without touching the runner, prompts, or UI wiring. This ADR removes a backend, not the abstraction.

## Alternatives considered

- **Keep both backends (status quo).** The strategic argument for the in-browser default was the offline-first promise. Rejected because the costs above (bundle, runtime fragility, quality ceiling, testing burden, model lifecycle) compounded across releases and the cloud path covers the same surface. The on-device **TTS** pipeline (the actual core product) remains fully offline; only AI transforms lose offline support.
- **Wait for a smaller / better-behaved local model.** A sub-1B model with acceptable translation quality, or a WASI-compiled runtime avoiding WebGPU entirely, could change the calculus. Rejected as a *defer* not a *block* — the abstraction is intact, so a future local backend can slot in without touching the runner, prompts, or UI wiring (see Reversibility above).
- **Hybrid: keep the in-browser backend as an opt-in power-user path.** Considered; rejected because the build/SW/feature-detect costs apply even when the path is opt-in (the chunks ship regardless), and the cloud path already serves power users with their own provider key.
