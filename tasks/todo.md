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
- [ ] T7 — Library "Reprocess" action (pre-fills modal from `Book.processing`); M3 audio cache invalidation on transform
- [ ] T8 — `<PronunciationReview/>` (confidence-ranked, bulk accept/reject, per-row edit); accepted entries → `Settings.cleaning.pronunciation`

## Phase 7 — End-to-end verify
- [ ] T9 — Both backends verified in browser; zero console errors; zero non-allowlisted requests; key absent from IDB/localStorage dumps; `pnpm verify` green

Checkpoint F — M6 shipped & `pnpm verify` green · ☐

---

### Ordering
T0 → T1 → (T2 ‖ T3) → T4 → T5 → (T6 ‖ T7 ‖ T8) → T9.

### Legend
- `[x]` done · `[ ]` pending · first `[ ]` is `/status`'s next task.
- Checkpoint ✅ = all tasks in the gated phases are `[x]` and verified green.
