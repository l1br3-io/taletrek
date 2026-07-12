# Spike: WebLLM in-browser LLM (WebGPU)

> **Status:** **All go/no-go questions ✅ confirmed and all hardware gates passed**
> (Firefox 152 desktop, iPhone Safari). M6 shipped. **Track:** T0 de-risking for
> [M6 — AI Transforms](../prds/M6-ai-transforms.md).

## Goal

Prove the M6 in-browser thesis — **a Qwen2.5-1.5B model runs end-to-end under
TaleTrek's Vite + Web Worker + OPFS stack** — before locking the dual-backend
architecture ([ADR-0003](../adr/0003-ai-transform-architecture.md)). Mirror the
M2 Piper spike process: three go/no-go questions + five fit findings.

Package under test: **`@mlc-ai/web-llm@0.2.84`** (Apache-2.0). Default model
hardcoded: **`Qwen2.5-1.5B-Instruct-q4f32_1-MLC`** (~1 GB, Q4f32, MIT weights).

## Verdict: ✅ integration holds — all three go/no-go questions pass

`@mlc-ai/web-llm` bundles cleanly under Vite 8 + a dedicated Web Worker using
its documented `CreateWebWorkerMLCEngine` / `WebWorkerMLCEngineHandler` pair.
The full JS stack loads, the WebGPU adapter initializes, the model downloads to
OPFS, persists across reloads, and inference produces plausible output.

**Go/no-go summary:**

| # | Question | Answer |
| - | -------- | ------ |
| 1 | Does `@mlc-ai/web-llm` bundle cleanly under Vite + dedicated Web Worker? | **✅ Yes.** Vite pre-bundles the lib (`/.vite/deps/@mlc-ai_web-llm.js` → 200); the worker spawns; init runs end-to-end. |
| 2 | Does the model persist to OPFS across reloads? | **✅ Yes.** First load caches to OPFS; on reload, `modelCached: true` and warm load is near-instant (no re-download). Verified in Firefox 152. |
| 3 | Does one inference round-trip produce plausible output? | **✅ Yes.** Cleanup transform produces correct, cleaned-up output on the sample text. Model: `Qwen2.5-1.5B-Instruct-q4f32_1-MLC`. |

If #2 or #3 fails on real hardware, spike ends and we re-evaluate per
ADR-0003 alternatives (different default model, transformers.js, or cloud-first).

## Results captured

### Desktop — Firefox 152 (system install, Linux, Intel iGPU + NVIDIA dGPU)

| Measurement | Value |
| ----------- | ----- |
| `navigator.gpu` present | **true** |
| `requestAdapter()` | **adapter found** (WebGPU initialized) |
| `crossOriginIsolated` | **false** (WebLLM/WebGPU works *without* COOP/COEP) |
| OPFS (`navigator.storage.getDirectory`) | **true** |
| `cacheBackend: "opfs"` accepted | **yes** |
| Model cached in OPFS after first load | **true** (`modelCached: true` on reload) |
| Warm load (OPFS) | **near-instant** (no re-download) |
| Cleanup transform output | **correct** (plausible, cleaned-up text) |

### Desktop — Chrome 148 (Flatpak build, MCP context)

| Measurement | Value |
| ----------- | ----- |
| `navigator.gpu` present | **true** (with `#enable-vulkan` + `#force-enable-webgpu-interop` flags) |
| `requestAdapter()` | **null** (Vulkan disabled in Flatpak bwrap sandbox — flags don't fix this) |
| Vite dep pre-bundle (`@mlc-ai_web-llm.js`) | **200** (clean) |
| Worker spawn | **clean** (no spawn error before adapter call) |

## Fit findings (inform M6, don't block)

4. **WebGPU availability is *not* `!!navigator.gpu`.** The API object is present
   even when no adapter is available. **M6 feature-detect must call
   `navigator.gpu.requestAdapter()` and treat `null` as "unsupported"** —
   `isReady()` on `WebLlmEngine` should do exactly this. Affects
   `lib/ai/engines/webllm.ts` design.
5. **Cold-start latency: confirmed fast on warm path.** Cold load downloads
   ~1 GB (first run). Warm load from OPFS is near-instant (no re-download).
   Exact `msToFirstToken` / `tokensSec` metrics not recorded in this run —
   the event log captures them per transform; record into this doc from a
   future session if perf tuning is needed. ADR-0003 budgeted "30+ min for
   a full book on a 1.5B model"; the per-paragraph number is what T1+ is
   built around.
6. **No public batched inference API.** `MLCEngineInterface` exposes only
   `chat.completions.create` (single request, OpenAI-shaped) + `interruptGenerate()`.
   The `batch*` symbols inside the bundle are internal GPU-kernel batching, **not**
   a multi-prompt API. **M6 dispatches one completion per chunk, sequentially.**
   ADR-0003's "batching not parallelism" therefore means *kernel-level* batching;
   TaleTrek cannot issue N prompts in one call. This caps throughput and makes
   per-paragraph checkpointing + "process in background tab" UX more important.
7. **Memory coexistence with Piper: not testable in this isolated spike.** The
   Piper voice and the LLM live in separate apps. **Defer to M6 integration.**
   Mitigation already in the plan: WebLlm worker has a 5-min idle teardown
   (mirrors `tts/client.ts`); ADR-0003 assumes one heavy model resident at a
   time. Verify GPU-memory pressure when both are loaded in T3/T9.
8. **PWA/Service-Worker conflict: low risk, unverified.** This spike ships no
   service worker. WebLLM fetches model weights from the HuggingFace CDN via
   standard `fetch` (cross-origin), so Workbox precache (same-origin build assets
   only) should not interact. **Verify in M6 via `pnpm preview` + hard reload**
   (existing gotcha #3) during T9. If the SW intercepts/caches weight requests
   unexpectedly, add an exclusion regex for the HF CDN.

## Critical gotcha: WebGPU on Linux needs Vulkan; Flatpak Chrome can't do it

The Flatpak Chrome (`com.google.Chrome`) cannot initialize Vulkan even with
`#enable-vulkan` and `#force-enable-webgpu-interop` flags enabled — the `bwrap`
sandbox blocks the Vulkan driver at a level flags can't fix.
`navigator.gpu.requestAdapter()` returns `null` silently.

**Working path: system Firefox.** Firefox 152 (system `/usr/bin/firefox`, not
Flatpak) has WebGPU enabled by default and initializes the adapter correctly on
this hardware (Intel iGPU + NVIDIA dGPU). This is how all three go/no-go
questions were verified.

**For M6 users:** if a reader's browser lacks a working WebGPU adapter,
`WebLlmEngine.isReady()` returns false and the UI nudges them to the cloud
backend (the ADR-0003 fallback). This is acceptable for a post-launch opt-in
feature.

## Model-ID correction (deviation from plan)

The plan referenced `Qwen2.5-1.5B-Instruct-Q4f32_1`. The **canonical** model id
in `prebuiltAppConfig` (WebLLM 0.2.84) is:

```
Qwen2.5-1.5B-Instruct-q4f32_1-MLC
```

(lowercase `q4f32_1`, trailing `-MLC`). `DEFAULT_AI_SETTINGS.inBrowser.modelId`
in T4 must use this exact string. Logged in `tasks/plan.md` deviations.

## Other implementation notes (grounded in installed types)

- **Worker pattern (documented, verified):** `worker.ts` =
  `new WebWorkerMLCEngineHandler()` + `self.onmessage = (m) => handler.onmessage(m)`;
  main = `CreateWebWorkerMLCEngine(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), modelId, { initProgressCallback, appConfig })`.
  This is the exact shape for M6 `lib/ai/engines/webllm.ts` + `lib/ai/worker.ts`.
- **Types exported:** `CreateWebWorkerMLCEngine`, `WebWorkerMLCEngineHandler`,
  `prebuiltAppConfig`, `MLCEngineInterface`, `MLCEngineConfig`, `AppConfig`,
  `InitProgressReport`, `hasModelInCache`, `deleteModelAllInfoInCache`,
  `deleteModelInCache`. **Not** exported: `ChatCompletionMessageParam` (define
  a local `{ role; content }` message type — runtime shape is what matters).
- **Cache control:** `AppConfig.cacheBackend: 'cache' | 'indexeddb' | 'opfs' | 'cross-origin'`.
  M6 uses `'opfs'` (mirrors Piper). `opfsAccessMode` defaults to `'async'`.
- **Interrupt:** `engine.interruptGenerate(): Promise<void>` is the public abort
  path (no `AbortSignal` on `create()`). M6's in-browser cancel uses this +
  worker `terminate`; the cloud engine uses `AbortSignal` (different per ADR).
- **JSON mode:** `response_format: { type: 'json_object' }` is supported — used
  by the pronunciation-hints op. Quality on a 1.5B model is a separate question
  (T1 prompts.ts + T9 review will surface it).
- **No COOP/COEP needed.** Unlike ORT multi-threaded Piper, WebLLM/WebGPU does
  not require cross-origin isolation. The M6 app stays COI-free (consistent with
  the single-threaded Piper default from M2).

## Recommendation for M6

1. **Lock `@mlc-ai/web-llm@0.2.84`** as the in-browser runtime. Apache-2.0 → add
   to `THIRD_PARTY_NOTICES.md` (ADR-0002 MIT claim stands).
2. **Default model id: `Qwen2.5-1.5B-Instruct-q4f32_1-MLC`** (corrected).
3. **`WebLlmEngine` in a dedicated worker** via `CreateWebWorkerMLCEngine`; cache
   backend `opfs`; idle teardown after 5 min (mirrors `tts/client.ts`).
4. **Feature-detect with `navigator.gpu.requestAdapter()`**, not `!!navigator.gpu`.
   Surface "WebGPU unavailable" → nudge to cloud backend.
5. **Dispatch transforms as sequential `chat.completions.create` calls** (one per
   chunk). No batched API exists. Budget UI for slow full-book runs.
6. **Licensing:** WebLLM Apache-2.0; Qwen2.5 weights MIT. Pipeline stays
   permissive-compatible. Add `THIRD_PARTY_NOTICES.md` entry in T1/T2.

## Remaining items

1. **~~#2 OPFS persistence (desktop):~~** ✅ confirmed — model caches to OPFS,
   warm load is near-instant, `modelCached: true` on reload.
2. **~~#3 Plausible inference (desktop):~~** ✅ confirmed — cleanup transform
   produces correct output.
3. **~~iOS Safari WebGPU~~:** ✅ confirmed on real iPhone.
4. **(Optional) memory coexistence with Piper:** only meaningful in M6
   integration — defer to T3/T9.
5. **(Optional) exact perf metrics:** the event log records `msToFirstToken`,
   `tokensSec`, `completionTokens` per transform. Record into this doc if perf
   tuning becomes needed.

## Non-goals (this spike)

- Translation/summarization *quality* benchmark — deferred to T1 prompts + T9.
- The cloud (OpenAI-compatible) backend — that path uses `fetch`, no spike needed.
- CSP `connect-src` verification — lands in T2 + T9.
- Real-iOS background audio — already covered by the M2/M3 Piper spike gate.

## Reproducing

Spike app lives at `spike/webllm/`. Run:

```
pnpm install
pnpm -C spike/webllm dev     # http://localhost:5175/
```

Click **Load model** (first load downloads ~1 GB), then exercise the transform
buttons. The Diagnostics panel + Event log capture every measurement referenced
above. Source files: `src/main.ts` (main thread), `src/worker.ts` (WebLLM
handler), `index.html` (UI).
