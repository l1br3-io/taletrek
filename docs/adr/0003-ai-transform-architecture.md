# ADR-0003: AI Transform Architecture — dual-backend, in-browser default

- **Status:** Accepted
- **Date:** 2026-07-12
- **Companion:** [`../prds/M6-ai-transforms.md`](../prds/M6-ai-transforms.md), [`0004-api-key-threat-model.md`](./0004-api-key-threat-model.md)

## Context

M6 adds an AI transform layer to TaleTrek: post-upload (or later via "Reprocess"), readers can run cleanup / translate / summarize / simplify / pronunciation-hint generation on a book's paragraphs. The feature must satisfy three constraints simultaneously:

1. **Preserve `VISION.md` non-goals** — "no backend, no cloud, no accounts." TaleTrek the service stays serverless and MIT-licensed.
2. **Serve offline-first readers** — the jog-mode use case (running, commuting, flights) breaks if transforms require network. The cleanup + pronunciation-hint workflows especially make sense offline, since they augment the on-device TTS pipeline.
3. **Serve power users who want quality** — small in-browser models cap out around GPT-3.5-class reasoning on translation and summarization. Readers who want GPT-4o / Claude / Gemini quality should be able to bring their own.

Additionally, the parse layer (M1) has already flattened books into `Chapter[]` with `paragraphs: string[]` — there is no need to re-solve format ingestion. Whatever MarkItDown-style markdown structuring might add (heading levels, lists, blockquotes) was discarded at parse time and is out of scope here.

## Decision

**Two backends behind one shared `AiTransformEngine` interface.**

```ts
interface AiTransformEngine {
  isReady(): Promise<boolean>
  transform(input: string[], op: TransformOp, onProgress?, signal?): Promise<string[]>
  proposePronunciationHints(sample: string[], onProgress?, signal?): Promise<PronunciationCandidate[]>
}
```

| Aspect | In-browser (default) | Cloud (opt-in) |
| ------ | -------------------- | -------------- |
| Runtime | WebGPU via `@mlc-ai/web-llm` (Apache-2.0) | Native `fetch` (no deps) |
| Default model | Qwen2.5-1.5B-Instruct (Q4, ~1GB) | User-configured |
| Storage | OPFS, mirroring Piper pattern (`tts/voices.ts`) | None |
| Worker | Dedicated Web Worker (mirrors `tts/`) | Main thread (`fetch` is non-blocking) |
| Network | None | OpenAI-compatible only |
| Key | None | In-memory only — see [ADR-0004](./0004-api-key-threat-model.md) |

Five structural commitments:

1. **No TaleTrek backend.** Cloud means the user's browser calls the user's chosen provider directly with the user's own key. TaleTrek ships no server, stores no keys server-side, brokers no requests.
2. **In-browser is the default when AI is enabled.** The offline promise holds. Cloud is the explicit power-user choice.
3. **Originals stay source of truth.** Raw bytes in the existing `files` store (gotcha #2). Re-process always re-parses from raw bytes via `parseInWorker`; no `transforms?` sidecar field, no layer/toggle UX. Simpler data model, matches existing philosophy.
4. **Pronunciation generation is LLM-proposes/user-reviews.** The LLM is a one-shot authoring tool for the existing global dictionary (`clean/pronunciation.ts:15`); accepted entries land there and the LLM leaves the hot path. TTS playback stays deterministic and offline.
5. **Single OpenAI-compatible client for cloud.** No per-provider SDKs. One `{baseUrl, apiKey, model}` config covers OpenAI, Anthropic (via their OpenAI-compat shim), OpenRouter, Groq, Together, Ollama, LM Studio — roughly 90% of the providers a power user would want.

## Consequences

- **TaleTrek ships its first non-TTS ML dependency** (`@mlc-ai/web-llm`, Apache-2.0 — permissive-compatible with MIT). A pre-implementation spike (T0) must verify Vite + Worker + PWA integration before locking. Mirrors the M2 Piper spike process.
- **Readers on browsers without WebGPU** (notably older iOS Safari) cannot use the in-browser backend. Feature-detect; fall back to cloud-only or disable with a clear message. Acceptable for a post-launch opt-in feature.
- **In-browser inference is slow** — a full-book transform on a 1.5B model can take 30+ minutes on a midrange laptop. Mitigations: smallest-viable model, batching (not parallelism — see below), per-paragraph checkpointing so tab crashes don't lose progress, "background tab" guidance in UI.
- **Cloud path is the user's relationship with their provider.** TaleTrek does not broker, log, or see the requests. Users with capped / scoped provider keys (OpenAI projects, Anthropic workspace limits) are nudged toward those.
- **M3 jog-mode audio cache must be invalidated** when transforms change `paragraphs` for affected chapters. M6 hooks `putChapters` to clear corresponding cached chunks.
- **Licensing stays clean** — WebLLM is Apache-2.0, Qwen2.5 models are MIT. ADR-0002's "fully MIT" claim stands with a new Apache-2.0 entry in `THIRD_PARTY_NOTICES.md`.

## Alternatives considered

1. **MarkItDown (Microsoft, Python)** — would give us high-fidelity markdown including heading levels, lists, tables, OCR. Rejected: Python 99.7%, depends on heavy CPython libraries (`pdfminer.six`, `python-pptx`, etc.) that don't run in a browser; its highest-quality converters are Azure cloud services, which violates the no-backend constraint. Running under Pyodide would add ~10MB+ of WASM and still wouldn't cover all backends. We don't need it — M1's parsers already cracked the format-ingestion problem; we're operating on `paragraphs: string[]`, not on opaque binary formats.

2. **Per-provider SDKs** (OpenAI SDK, Anthropic SDK, Google SDK, etc.) — maximal fidelity per provider, but lots of code surface, lots of dependencies, lots of version drift. The OpenAI-compatible API is the de-facto standard; providers maintain compat at their end. One integration covers ~90% of providers; the long tail can wait.

3. **Encrypted key at rest (Tier-2/3)** — sounds more secure, adds nothing real. The JS that encrypted the key also has to decrypt it, so an attacker who can run TaleTrek's JS can get the key anyway. It's obfuscation, not protection. Worse: it lulls users into a false sense of security. Rejected for v1 in [ADR-0004](./0004-api-key-threat-model.md).

4. **Non-destructive `transforms?` sidecar field + toggle UX** — preserve originals alongside transformed output, let readers A/B in the reader view. Rejected: doubles storage, complicates the data model, requires a toggle UI nobody asked for. The raw file in `files` is already the source of truth; "undo" via re-process from raw bytes is one tap from the library menu.

5. **Cloud-only (skip in-browser)** — simpler, but breaks the offline promise that defines TaleTrek. The cleanup and pronunciation-hint workflows especially make sense offline because they augment the on-device TTS pipeline. In-browser is the strategic default; cloud is the power-user escape hatch.

6. **In-browser only (skip cloud)** — purer, but caps quality at small-model reasoning. Translation and summarization on a 1.5B model are visibly weaker than on GPT-4o. Readers who want quality should be able to opt in without abandoning TaleTrek. The whole cloud path is ~200 lines of `fetch` + SSE parsing; the cost of including it is low.
