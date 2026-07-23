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
| M6 — AI Transforms | ✅ **Done** (cloud-only after ADR-0005; cleanup/translate/summarize/simplify, per-paragraph transforms, importable key/config) | [`docs/prds/M6-ai-transforms.md`](docs/prds/M6-ai-transforms.md) · [`docs/adr/0005-remove-in-browser-llm-backend.md`](docs/adr/0005-remove-in-browser-llm-backend.md) · [`tasks/todo.md`](tasks/todo.md) |
| M6.1 — Biometric Key Caching | ✅ **Done** (opt-in WebAuthn PRF tier on top of M6's in-memory default; auto-falls-back where unsupported. ADR-0007 augments ADR-0004.) | [`docs/adr/0007-biometric-key-caching.md`](docs/adr/0007-biometric-key-caching.md) · [`tasks/plan-m6.1-biometric-keys.md`](tasks/plan-m6.1-biometric-keys.md) |
| M7 — Reader UX & Mobile | ✅ **Done** (responsive layout + nav drawer, chapter outline, minimized playback menu, go-to-current + FAB, auto-scroll on first Play) | [`docs/prds/M7-reader-ux-mobile.md`](docs/prds/M7-reader-ux-mobile.md) |
| M8 — Audio Cache | ✅ **Done** (on-device audio cache, LRU-bounded ~500 MB, per-book clear, Settings indicator + Clear button) | [`docs/prds/M8-audio-cache.md`](docs/prds/M8-audio-cache.md) |
| M8.1 — iOS Huge-Book Upload Resilience | ✅ **Done** (mobile encode cap + upload resilience; verified 2026-07-18) | [`tasks/plan-m8.1-ios-upload-resilience.md`](tasks/plan-m8.1-ios-upload-resilience.md) |
| M9 — Mobile Streaming Playback | ⏸ **Deferred** per ADR-0010 — superseded for the common case by M11. Design + dormant scaffolding stay as the fallback path. | [`docs/prds/M9-mobile-streaming.md`](docs/prds/M9-mobile-streaming.md) · [`docs/adr/0006-mobile-mse-streaming.md`](docs/adr/0006-mobile-mse-streaming.md) · [`docs/adr/0010-playback-engine-architecture.md`](docs/adr/0010-playback-engine-architecture.md) |
| M10 — PDF Structure Extraction | ✅ **Done** (pdfjs outline → chapters at upload; AI-only fallback; heuristic detector deleted. ADR-0008.) | [`docs/adr/0008-pdf-structure-extraction.md`](docs/adr/0008-pdf-structure-extraction.md) |
| M11 — Pluggable Playback Engines, Pausable Synthesis | 🚧 **In progress** (native engine default + FFmpeg fallback; pausable synthesis; mobile synth lockdown. ADR-0010 supersedes ADR-0006.) | [`tasks/plan-m11-playback-engines.md`](tasks/plan-m11-playback-engines.md) · [`docs/adr/0010-playback-engine-architecture.md`](docs/adr/0010-playback-engine-architecture.md) · [`docs/spikes/web-audio-mobile.md`](docs/spikes/web-audio-mobile.md) |
| M12 — Parallel Synthesis | ✅ **Done** (bounded multi-worker pool for pre-synth; verified 2026-07-19 on iPhone + desktop. ADR-0011.) | [`docs/adr/0011-parallel-synthesis-pool.md`](docs/adr/0011-parallel-synthesis-pool.md) · [`docs/spikes/phonemize-module-reuse.md`](docs/spikes/phonemize-module-reuse.md) |
| M13 — Whole-Book Streaming AI Transform | 🚧 **In progress** (in-place streaming transforms; pause/resume/cancel; playback blocked while running. ADR-0012.) | [`tasks/plan-m13-whole-book-streaming-transform.md`](tasks/plan-m13-whole-book-streaming-transform.md) · [`docs/adr/0012-whole-book-streaming-transform.md`](docs/adr/0012-whole-book-streaming-transform.md) |

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
pnpm -C spike/piper dev       # Piper spike app on :5174 (throwaway)
pnpm -C spike/web-audio dev   # Web Audio mobile-engine spike on :5175 (M11 gate)
```

Workspace: pnpm, `web/` (the app) + `spike/piper/` + `spike/web-audio/` (throwaway de-risking apps). Node 24, pnpm 10.31.0.

## Layout

```
docs/          VISION, ROADMAP, prds/, spikes/, adr/
web/           the PWA — Vite 8 + React 19 + TS + RR8 + Tailwind v4 + Biome
  src/
    routes/      landing, reader, settings, not-found (+ tests)
    components/  Layout, Nav (presentational)
    context/     settings.tsx (SettingsProvider — low-freq Context)
    hooks/       useSetting
    lib/         db.ts (idb), storage.ts (persist), media-session.ts,
                 crypto/ (aes.ts, prf.ts — ADR-0007 biometric key caching)
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
- **Icons: [`lucide-react`](https://lucide.dev) (tree-shaken ESM, `stroke="currentColor"`).** Import each icon by name (`import { Play } from 'lucide-react'`) — never import the whole lib. Decorative icons are auto-`aria-hidden`; the button's `aria-label`/visible text is the accessible name. Size via Tailwind: `h-4 w-4` inline with `text-sm`, `h-5 w-5` standalone/FAB; color flows from the button's `text-*` token (never hard-coded). The `❯~` brand mark in `Nav.tsx` stays as ASCII (not an icon).

## Critical gotchas (index)

Full detail lives in [`docs/gotchas.md`](docs/gotchas.md) — **read the relevant entry on demand** before touching that area. The titles below are your scan list; if your task touches the named area, open the link.

1. **ORT pinned to 1.18.0 — silent inference deadlock** — [`G1`](docs/gotchas.md#g1)
2. **Safari ITP deletes script storage after 7 days** — [`G2`](docs/gotchas.md#g2)
3. **Dev Service Worker caches stale bundles** — [`G3`](docs/gotchas.md#g3)
4. **License is MIT (ADR-0002); GPL is fallback-only** — [`G4`](docs/gotchas.md#g4)
5. **iOS lock-screen background playback needs real-hardware verification** — [`G5`](docs/gotchas.md#g5)
6. **Web Workers have no DOMParser — use fast-xml-parser** — [`G6`](docs/gotchas.md#g6)
7. **pdfjs-dist must be lazy-imported (DOMMatrix crashes jsdom)** — [`G7`](docs/gotchas.md#g7)
8. **Send file bytes, not the File, to a worker** — [`G8`](docs/gotchas.md#g8)
9. **WebGPU / WebLLM backend removed (ADR-0005)** — [`G9`](docs/gotchas.md#g9)
10. **iOS Safari MSE is `<video>`-only** — [`G10`](docs/gotchas.md#g10)
11. **FFmpeg WASM core ~30 MB, single-threaded only** — [`G11`](docs/gotchas.md#g11)
12. **SourceBuffer.appendBuffer is async — no overlapping appends** — [`G12`](docs/gotchas.md#g12)
13. **`<video>` pauses on iOS lock screen — accepted limitation** — [`G13`](docs/gotchas.md#g13)
14. **WebAuthn PRF cannot be unit-tested in jsdom** — [`G14`](docs/gotchas.md#g14)
15. **crypto.subtle is a built-in API, not a network call** — [`G15`](docs/gotchas.md#g15)
16. **Wrapped-DEK pattern is load-bearing — don't simplify** — [`G16`](docs/gotchas.md#g16)
17. **PDF outline = pdfjs only; AI is the only fallback** — [`G17`](docs/gotchas.md#g17)
18. **Upload wake lock is best-effort; boot-sweep recovery rules** — [`G18`](docs/gotchas.md#g18)
19. **Worker error boundaries preserve DOMException identity** — [`G19`](docs/gotchas.md#g19)
20. **Mobile whole-book encode has a hard cap (~200 MB)** — [`G20`](docs/gotchas.md#g20)
21. **Active upload jobs pin audio-cache entries** — [`G21`](docs/gotchas.md#g21)
22. **Pluggable playback engines — Web Audio default, FFmpeg fallback** — [`G22`](docs/gotchas.md#g22)
23. **Web Audio scheduler: setInterval not rAF; re-anchor on seek** — [`G23`](docs/gotchas.md#g23)
24. **Pausable synthesis persists via uploadJob with uploading=false** — [`G24`](docs/gotchas.md#g24)
25. **Parallel synthesis — PoolEngine, pre-synth only, mobile cap=2** — [`G25`](docs/gotchas.md#g25)
26. **Whole-book streaming transform — in-place, resume mirrors uploadJob** — [`G26`](docs/gotchas.md#g26)

## How to resume (in a new session)

Open opencode in this repo and say, e.g.:

> "Continue with M1 — Upload & Read. Read `docs/ROADMAP.md` and `docs/prds/M0-foundation.md` for established patterns, then plan M1 following the spec-driven workflow. The Piper integration is M2, not M1."

The agent auto-loads this file + `.opencode/rules/tech.md`. The **Status table above** links each milestone to its PRD, ADR, and task plan — start there for the relevant docs. For TTS work, also read [`docs/spikes/piper-wasm.md`](docs/spikes/piper-wasm.md) (M2 recommendations: pin ORT 1.18.0, mirror wasm locally, single-threaded default, Web Worker, pre-download model to OPFS).

## Non-goals (launch scope)

Cloud TTS/sync/store, accounts, multi-user, native app stores, DRM circumvention. See `docs/VISION.md`.
