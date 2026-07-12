# M6 — AI Transforms · Task checklist

> Source of truth for `/status` and `/build`. Task detail + dependencies live in
> [`plan.md`](./plan.md); spec in [`docs/prds/M6-ai-transforms.md`](../docs/prds/M6-ai-transforms.md);
> architecture + key threat model in [`docs/adr/0003-ai-transform-architecture.md`](../docs/adr/0003-ai-transform-architecture.md)
> + [`docs/adr/0004-api-key-threat-model.md`](../docs/adr/0004-api-key-threat-model.md).
> Checkpoints gate phases: A spike → B types → C engines → D settings → E modal → F shipped.

## Phase 1 — WebLLM spike (de-risk before commit)
- [~] T0 — `spike/webllm/` throwaway app built; **go/no-go #1 (Vite+Worker bundle) ✅ confirmed**; #2 (OPFS) + #3 (inference) **pending real-hardware run** (desktop MCP Chrome has Vulkan disabled → no WebGPU adapter; user runs locally + on iPhone). Fit findings captured: feature-detect must use `requestAdapter()`; WebGPU works w/o COOP/COEP; **no public batched API** (sequential per chunk); Flatpak-Chrome-Vulkan gotcha; model-id corrected to `Qwen2.5-1.5B-Instruct-q4f32_1-MLC`. Output: `docs/spikes/webllm.md` (written).

Checkpoint A — WebLLM spike proves viable · ◐ (#1 confirmed; #2/#3 + iPhone pending user run — **non-blocking for T1 per user**)

## Phase 2 — Types + keyring + chunking
- [x] T1 — `AiTransformEngine`, `TransformOp`, `AppliedProcessing`, `AiSettings`, `PronunciationCandidate` types; `keyring` (in-memory, zero persistence asserted); `chunk` strategies (solo / windowed / sample) · **`pnpm verify` green (24 new tests)**

Checkpoint B — Types/keyring/chunk locked · ✅

## Phase 3 — Engines (parallel)
- [x] T2 — `engines/openai.ts` (fetch + SSE + AbortSignal + typed `CloudError`); `engines/sse.ts` + `prompts.ts` + `chunksForOp`; CSP `connect-src` shipped via build-only Vite plugin (app shell loads clean under it, zero console errors; block test → T9) · **`pnpm verify` green (+43 tests, 322 total)**
- [x] T3 — `engines/webllm.ts` (lazy-import + `requestAdapter()` feature-detect + signal→`interruptGenerate` bridge + idle teardown); `webllm.worker.ts` (WebLLM native handler); shared `runner.ts` (orchestration extracted from T2); `client.ts` (backend factory); `webgpu.ts` · **+24 tests, 346 total. Architecture B (spike-driven): WebLLM's own worker protocol, no custom protocol.ts**

Checkpoint C — Both backends functional · ◐ (cloud fully tested; in-browser code-complete + unit-tested, real-WebGPU verify pending user's #2/#3 run)

## Phase 4 — Settings UI
- [x] T4 — `ai?` on `Settings` + `DEFAULT_AI_SETTINGS`; `<AiSettingsSection/>` (enable toggle gates, backend radio, in-browser model id, cloud baseUrl+model+key via keyring, modal-timing flags) · **browser-verified: renders + toggle + backend swap, console clean** · `pnpm verify` green (+6 tests, 352 total)

Checkpoint D — Settings wired · ✅

## Phase 5 — Post-process modal + hook
- [x] T5 — `<PostProcessModal/>` (presentational: checkboxes + per-op params, progress bar, done/error); `useAiTransform` (variant state, chains ops across chapters, abort, **on completion: writes chapters + processing + resets position to `(chapterIndex, 0)` + toast message**); `Book.processing?` + `db.updateBookProcessing` · **+18 tests, 370 total. lib/ai not yet app-wired (hook+modal unmounted → T6)**

Checkpoint E — End-to-end post-process on one book · ✅ (upload→modal→transform→write→reset wired via `library.tsx`; verified by library + hook tests; real-engine browser E2E → T9)

## Phase 6 — Wiring (parallel)
- [x] T6 — Upload-flow modal hooks in `routes/library.tsx`: `beforeUpload` → `<PostProcessModal/>` before pick (via `UploadButton.onBeforePick`); `afterUpload` (default) → modal after parse; both → post pre-filled from stash; cancel proceeds; `ai.enabled===false` → no modals (plain M1). Engine resolved via `getAiEngine` (cached); in-browser `prepare` loads the model. **+4 library tests (375 total). lib/ai now app-wired → WebLLM code-splits (webllm-runtime 5.7MB + webllm.worker 5.8MB lazy; main 342K)**
- [x] T7 — Library "Reprocess" action on `BookCard` (presentational `onReprocess?`, shown only when AI enabled); `routes/library.tsx` unifies post-upload + reprocess into one `RunContext`-driven modal; reprocess re-parses the original file (`lib/reprocess.ts:reparseChapters` → `getBookFile`→`parseInWorker`, preserves existing chapter IDs by index) so transforms start from pristine paragraphs (idempotent re-runs). Hook gains optional `resolveChapters` ("Re-parsing original…" stage). `opsFromProcessing` pre-fills modal from `Book.processing`. **+7 tests (382 total). M3 audio-cache invalidation is a no-op — `useParagraphPlayer` pre-renders in-memory only, no persistent cache; reader isn't mounted during a library-side transform**
- [x] T8 — `<PronunciationReview/>` modal (presentational: ranked candidates by confidence, per-row edit + accept, bulk "Accept high-confidence ≥80%" threshold, save → collapses to `PronunciationEntry` dropping confidence/category). `usePronunciationHints` hook (scans first chapter via `engine.proposePronunciationHints`, variant state + abort). "Hints" action on `BookCard` (AI-gated). Accepted entries dedup-merge into `Settings.cleaning.pronunciation` (case-insensitive, existing wins). **+19 tests (401 total)**

## Phase 7 — End-to-end verify
- [x] T9 — **Browser-verified (MCP, dev server, no SW):** app loads clean (zero console errors/warnings); AI settings toggle persists through reload; cloud backend fields render (base URL, model, API key save/forget); in-browser backend fields render (model id, WebGPU note); book cards show Reprocess + Hints + Delete when AI enabled; upload → post-process modal fires (afterUpload); checkboxes toggle Process button; pronunciation review modal opens from Hints + handles no-key error gracefully; reprocess modal opens from Reprocess action. **ADR-0004 security verified: dummy key absent from IndexedDB + localStorage + sessionStorage; `ai.cloud` has no `apiKey` field.** **Cloud transform pipeline verified via mock OpenAI server:** SSE parsing, chunking, paragraph writing, processing record, position reset, pronunciation hints (JSON SSE → candidates → accept → dictionary merge) — all end-to-end, zero console errors. **Hardware-gated items remaining (user):** real cloud LLM quality (pipeline proven via mock; a real key only adds quality verification), WebLLM spike #2/#3 (needs Vulkan browser), iPhone WebGPU gate. `pnpm verify` green (401 tests)

Checkpoint F — M6 shipped & `pnpm verify` green · ☐

---

### Ordering
T0 → T1 → (T2 ‖ T3) → T4 → T5 → (T6 ‖ T7 ‖ T8) → T9.

### Legend
- `[x]` done · `[ ]` pending · first `[ ]` is `/status`'s next task.
- Checkpoint ✅ = all tasks in the gated phases are `[x]` and verified green.
