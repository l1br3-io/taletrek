# Spike: WebLLM in-browser LLM (WebGPU)

> **Status:** Integration confirmed (go/no-go #1 ✅). OPFS + inference (#2, #3)
> pending a real-WebGPU run by the user — the desktop MCP Chrome has Vulkan
> disabled (Flatpak sandbox), so cannot run the GPU path. See "Remaining items".
> **Track:** T0 de-risking for [M6 — AI Transforms](../prds/M6-ai-transforms.md).

## Goal

Prove the M6 in-browser thesis — **a Qwen2.5-1.5B model runs end-to-end under
TaleTrek's Vite + Web Worker + OPFS stack** — before locking the dual-backend
architecture ([ADR-0003](../adr/0003-ai-transform-architecture.md)). Mirror the
M2 Piper spike process: three go/no-go questions + five fit findings.

Package under test: **`@mlc-ai/web-llm@0.2.84`** (Apache-2.0). Default model
hardcoded: **`Qwen2.5-1.5B-Instruct-q4f32_1-MLC`** (~1 GB, Q4f32, MIT weights).

## Verdict: integration holds; runtime pending hardware

`@mlc-ai/web-llm` bundles cleanly under Vite 8 + a dedicated Web Worker using
its documented `CreateWebWorkerMLCEngine` / `WebWorkerMLCEngineHandler` pair.
The full JS stack loads and reaches the WebGPU adapter request. The only failure
in the MCP browser is environmental (no Vulkan in the Flatpak Chrome sandbox),
not a code or bundle defect.

**Go/no-go summary:**

| # | Question | Answer |
| - | -------- | ------ |
| 1 | Does `@mlc-ai/web-llm` bundle cleanly under Vite + dedicated Web Worker? | **✅ Yes.** Vite pre-bundles the lib (`/.vite/deps/@mlc-ai_web-llm.js` → 200); the worker spawns; init runs end-to-end. |
| 2 | Does the model persist to OPFS across reloads? | **⏳ Pending real-hardware run.** `cacheBackend: "opfs"` is configured and `hasModelInCache()` reports correctly; the adapter failure prevented a download. Verify per "Remaining items." |
| 3 | Does one inference round-trip produce plausible output? | **⏳ Pending real-hardware run.** Streaming + `stream_options.include_usage` + JSON-mode wiring is in place; needs a GPU to execute. |

If #2 or #3 fails on real hardware, spike ends and we re-evaluate per
ADR-0003 alternatives (different default model, transformers.js, or cloud-first).

## Results captured (Chrome 148, Linux, Flatpak build, MCP context)

| Measurement | Value |
| ----------- | ----- |
| `navigator.gpu` present | **true** |
| `requestAdapter()` | **null** (Vulkan disabled in sandbox — see gotcha) |
| `crossOriginIsolated` | **false** (WebLLM/WebGPU works *without* COOP/COEP) |
| OPFS (`navigator.storage.getDirectory`) | **true** |
| `cacheBackend: "opfs"` accepted | **yes** (typed `CacheBackend` union) |
| `chrome://gpu` → WebGPU | "Hardware accelerated*" listed |
| `chrome://gpu` → Vulkan | **Disabled** ← root cause of null adapter |
| Vite dep pre-bundle (`@mlc-ai_web-llm.js`) | **200** (clean) |
| Worker spawn (`new URL('./worker.ts', import.meta.url)`) | **clean** (no spawn error before adapter call) |

## Fit findings (inform M6, don't block)

4. **WebGPU availability is *not* `!!navigator.gpu`.** The API object is present
   even when no adapter is available. **M6 feature-detect must call
   `navigator.gpu.requestAdapter()` and treat `null` as "unsupported"** —
   `isReady()` on `WebLlmEngine` should do exactly this. Affects
   `lib/ai/engines/webllm.ts` design.
5. **Cold-start latency: not yet measured** (needs real GPU). The spike records
   `msToFirstToken`, `totalMs`, `completionTokens`, `tokensSec`, and
   `runtimeStatsText()` per run — fill in from the local run. ADR-0003 budgeted
   "30+ min for a full book on a 1.5B model"; the per-paragraph number is what
   T1+ will be built around.
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

## Critical gotcha: WebGPU on Linux needs Vulkan; Flatpak Chrome disables it

`chrome://gpu` reports `WebGPU: Hardware accelerated` **but** `Vulkan: Disabled`.
Chrome's WebGPU backend (Dawn) on Linux is Vulkan-backed; with Vulkan off,
`navigator.gpu.requestAdapter()` returns `null` **with no error** — the API is
"present" but adapter-less. This silently breaks the entire in-browser path.

**This affects the user's daily browser on this machine:** the Chrome launched
by `/home/jpt/.local/bin/google-chrome` is the **Flatpak** build
(`/app/extra/chrome` under `bwrap`), which ships Vulkan disabled by default. So
M6's in-browser backend will **not** run in the Flatpak Chrome without action.

**To run the spike locally (#2, #3), use a Vulkan-capable browser:**

- A **system (non-Flatpak)** Chromium/Chrome with the NVIDIA Vulkan driver
  (`nvidia_vulkan_icd_loader` + `nvidia_vulkan_icd` on most distros), or
- Launch with `--enable-features=Vulkan` if the driver is present, or
- Firefox (WebGPU behind `dom.webgpu.enabled` + `gfx.ordered-async-queue`),
  though TaleTrek targets Chromium first.

**For M6 users:** document the same. If a reader's browser lacks a working
WebGPU adapter, `WebLlmEngine.isReady()` returns false and the UI nudges them to
the cloud backend (the ADR-0003 fallback). This is acceptable for a post-launch
opt-in feature.

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

## Remaining items (need real hardware / user)

1. **#2 OPFS persistence (desktop):** in a Vulkan-capable browser, click
   *Load model* (first run downloads ~1 GB to OPFS, note the `ms`), reload the
   page, click *Load model* again — the warm load should be dramatically faster
   and `modelCached` should read `true` immediately. Then DevTools → Network →
   Offline → reload → *Load* (should succeed with zero network requests).
2. **#3 Plausible inference (desktop):** click each transform op (Cleanup,
   Translate, Summarize, Simplify, Pronunciation hints) on the default sample
   and record the event-log metrics into this doc's Results table. Pronunciation
   hints should return a parseable JSON object with ≥1 candidate.
3. **iOS Safari WebGPU (real iPhone — gotcha #5 + manual gate):** open the spike
   URL on the iPhone (HTTPS required), confirm `webgpu: true` **and**
   `requestAdapter()` returns non-null, run one inference. If iOS Safari lacks
   WebGPU, document as a known limitation (iOS falls back to cloud per ADR-0003).
4. **(Optional) memory coexistence with Piper:** only meaningful in M6
   integration — defer to T3/T9.

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
