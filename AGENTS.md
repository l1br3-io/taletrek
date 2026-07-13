# TaleTrek — Agent Guide

> Free, open-source **reading companion** by **l1br3**: turn any ebook (PDF/EPUB/MOBI/TXT) into an audiobook with on-device neural TTS (Piper, WASM). Ships as an installable, offline-first PWA. No backend, no cloud, MIT-licensed.

## Status

| Milestone | State | Doc |
| --------- | ----- | ---- |
| M0 — Foundation | ✅ **Done** (commit `e9bdd61`) | [`docs/prds/M0-foundation.md`](docs/prds/M0-foundation.md) |
| Piper spike | ✅ Done (thesis proven in-browser) | [`docs/spikes/piper-wasm.md`](docs/spikes/piper-wasm.md) |
| M1 — Upload & Read | ✅ **Done** (PDF/EPUB/MOBI/TXT slice; commit `71a642b`) | [`docs/prds/M1-upload-read.md`](docs/prds/M1-upload-read.md) |
| M2 — Speak | ✅ **Done** (Piper TTS, per-paragraph read-along, voice picker, speed) | [`docs/prds/M2-speak.md`](docs/prds/M2-speak.md) |
| M3 — Jog Mode | ✅ **Done** (pre-rendered chunks, `<audio>`, Media Session) | [`docs/prds/M3-jog.md`](docs/prds/M3-jog.md) |
| M4 — Clean Reading | ✅ **Done** (filters + pronunciation dictionary; commit `d57a8bf`) | [`docs/prds/M4-clean-reading.md`](docs/prds/M4-clean-reading.md) |
| M5 — Library & Offline | ✅ **Done** (library, resume, offline voice mgmt, PWA polish; commit `4115f00`) | [`docs/prds/M5-library-offline.md`](docs/prds/M5-library-offline.md) |
| M6 — AI Transforms | ✅ **Done** (in-browser WebLLM + opt-in cloud, cleanup/translate/summarize/simplify/pronunciation-hints, per-paragraph transforms + importable key/config) | [`docs/prds/M6-ai-transforms.md`](docs/prds/M6-ai-transforms.md) · [`docs/spikes/webllm.md`](docs/spikes/webllm.md) · [`tasks/todo.md`](tasks/todo.md) |
| M7 — Reader UX & Mobile | ✅ **Done** (responsive layout + nav drawer, chapter outline, minimized `⋯` playback menu, go-to-current + FAB, auto-scroll to resumed position on first Play) | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| M8 — Audio Cache | ✅ **Done** (content-addressed IndexedDB audio cache, LRU-bounded ~500 MB, per-book cascade clear, Settings indicator + Clear button) | [`docs/prds/M8-audio-cache.md`](docs/prds/M8-audio-cache.md) |

**Read first:** [`docs/VISION.md`](docs/VISION.md) (the why) → [`docs/ROADMAP.md`](docs/ROADMAP.md) (milestones) → [`docs/prds/M0-foundation.md`](docs/prds/M0-foundation.md) (what shipped, patterns, conventions).

## Commands

```
pnpm install              # install all workspace deps
pnpm dev                  # Vite dev server (web/)
pnpm build                # production build → web/dist
pnpm preview              # serve built dist
pnpm typecheck            # tsc --noEmit
pnpm lint                 | biome check (spike/ excluded)
pnpm lint:fix             # biome check --write
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build (run before commits)
pnpm -C spike/piper dev   # Piper spike app on :5174 (throwaway)
```

Workspace: pnpm, `web/` (the app) + `spike/piper/` (throwaway). Node 24, pnpm 10.31.0.

## Layout

```
docs/          VISION, ROADMAP, prds/, spikes/, adr/
web/           the PWA — Vite 8 + React 19 + TS + RR8 + Tailwind v4 + Biome
  src/
    routes/      landing, reader, settings, not-found (+ tests)
    components/  Layout, Nav (presentational)
    context/     settings.tsx (SettingsProvider — low-freq Context)
    hooks/       useSetting
    lib/         db.ts (idb), storage.ts (persist), media-session.ts
spike/piper/   throwaway Piper TTS validation app
.opencode/     harness config (agents, rules, skills, tech) — versioned
```

## Conventions (from `.opencode/tech/{typescript,react}/`)

- **Strict TS**, branded IDs, interfaces-before-impl
- **Container/presentational split**; Context for low-frequency state only (settings/theme) — never playback
- **Variant types** for async states: `{ type: 'loading' } | { type: 'ready'; data }`
- IndexedDB via `idb`; OPFS for large blobs (models, audio) lands in M2/M5
- Tests co-located (`*.test.tsx`), Vitest + Testing Library + fake-indexeddb
- No comments unless asked; Biome handles format/import-order

## Critical gotchas (do not relearn these)

1. **`onnxruntime-web` must be pinned to `1.18.0`** — `@mintplex-labs/piper-tts-web` hardcodes the ORT wasm to cdnjs@1.18.0; any other JS version deadlocks inference silently. Mirror the wasm locally for M2 (see spike doc).
2. **Safari deletes script storage after 7 days of no interaction (ITP).** Design cached models/audio as re-hydratable; call `navigator.storage.persist()`. The original uploaded file is source of truth.
3. **Dev SW caches stale bundles** — when verifying source changes in-browser, unregister the SW or test via `pnpm preview` (production build) + hard reload.
4. **License: fully MIT** (ADR-0002). The GPL option (ADR-0001) is fallback-only. Do not re-litigate unless the MIT package breaks.
5. **iOS lock-screen background playback is NOT yet verified on real hardware** — the desktop MCP can't test it. Validate on a real iPhone before M3 commits to it.
6. **Web Workers have no `DOMParser`.** The EPUB parser runs inside the parse worker, so it uses `fast-xml-parser` (worker-safe), not the DOM. Any future parsing that needs a DOM must stay on the main thread or use a worker-safe parser. Unit tests can't catch this (jsdom has DOMParser) — only a real browser run does.
7. **`pdfjs-dist` is lazy-imported inside `parse()`** — importing it at module top-level pulls `DOMMatrix` at load, which crashes jsdom. Keep the dynamic `await import('pdfjs-dist')` in `pdf.ts`.
8. **Send file *bytes*, not the `File`, to a worker.** `parseInWorker` reads `file.arrayBuffer()` on the main thread and transfers the `ArrayBuffer`; the worker reconstructs the `File`. Cloning a `File` across the worker boundary can fail for files backed by a filesystem path.
9. **WebGPU feature-detect needs `requestAdapter()`, not `!!navigator.gpu`.** The API object is present even with no adapter. M6's `WebLlmEngine.isReady()` must call `navigator.gpu.requestAdapter()` and treat `null` as unsupported. **The desktop MCP Chrome is the Flatpak build under `bwrap` — Vulkan is blocked at the sandbox level** → `requestAdapter()` returns null even with `#enable-vulkan` + `#force-enable-webgpu-interop` flags enabled. **System Firefox 152 works** (WebGPU enabled by default, adapter initializes correctly). For GPU/WebLLM browser testing, use system Firefox or a non-Flatpak Chromium. See [`docs/spikes/webllm.md`](docs/spikes/webllm.md).

## How to resume (in a new session)

Open opencode in this repo and say, e.g.:

> "Continue with M1 — Upload & Read. Read `docs/ROADMAP.md` and `docs/prds/M0-foundation.md` for established patterns, then plan M1 following the spec-driven workflow. The Piper integration is M2, not M1."

The agent auto-loads this file + `.opencode/rules/tech.md`. For TTS work, also point it at [`docs/spikes/piper-wasm.md`](docs/spikes/piper-wasm.md) (M2 recommendations: pin ORT 1.18.0, mirror wasm locally, single-threaded default, Web Worker, pre-download model to OPFS). For M6 (AI transforms), point it at [`docs/spikes/webllm.md`](docs/spikes/webllm.md) + [`tasks/plan.md`](tasks/plan.md) (WebLLM worker pattern, OPFS cache, model id `Qwen2.5-1.5B-Instruct-q4f32_1-MLC`, no batched API).

## Non-goals (launch scope)

Cloud TTS/sync/store, accounts, multi-user, native app stores, DRM circumvention. See `docs/VISION.md`.
