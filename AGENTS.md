# TaleTrek — Agent Guide

> Free, open-source **reading companion** by **l1br3**: turn any ebook (PDF/EPUB/MOBI/TXT) into an audiobook with on-device neural TTS (Piper, WASM). Ships as an installable, offline-first PWA. No backend, no cloud, MIT-licensed.

## Current effort

**None active (between phases).** The last effort — M11 (Pluggable Playback Engines, Pausable Synthesis) — shipped 2026-07-19; its spec lives at [`docs/specs/playback-engines-pausable-synth/spec.md`](docs/specs/playback-engines-pausable-synth/spec.md). The next effort starts fresh at `/spec`, which creates `docs/specs/<effort-slug>/spec.md`.

Live status always lives in the current effort's `spec.md` frontmatter (`status:`) + `todo.md` — **not here**.

- Ship history: [`CHANGELOG.md`](CHANGELOG.md) · Direction + lifecycle: [`docs/ROADMAP.md`](docs/ROADMAP.md)

**Read first:** [`docs/VISION.md`](docs/VISION.md) (the why) → [`docs/ROADMAP.md`](docs/ROADMAP.md) (direction + the DEFINE→SHIP lifecycle) → the current effort's `docs/specs/<slug>/spec.md` (when one is active). For established patterns, read a relevant shipped spec under [`docs/specs/`](docs/specs/).

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
docs/
  VISION.md       narrative "why" (frozen)
  ROADMAP.md      themes + milestones + DEFINE→SHIP lifecycle
  specs/          one dir per effort: <slug>/{spec.md, plan.md, todo.md, tasks/00N-*.md}
                  spec.md frontmatter carries lifecycle: status draft|active|shipped|abandoned
  adrs/           immutable decisions (supersede via a new ADR only)
  gotchas.md      runtime gotchas (G1…)
  spikes/         de-risking notes (piper-wasm, web-audio-mobile, …)
web/              the PWA — Vite 8 + React 19 + TS + RR8 + Tailwind v4 + Biome
  src/
    routes/         landing, reader, settings, not-found (+ tests)
    components/     Layout, Nav (presentational)
    context/        settings.tsx (SettingsProvider — low-freq Context)
    hooks/          useSetting
    lib/            db.ts (idb), storage.ts (persist), media-session.ts,
                    crypto/ (aes.ts, prf.ts — ADR-0007 biometric key caching)
spike/piper/       throwaway Piper TTS validation app
```

## Conventions

- **Strict TS**, branded IDs, interfaces-before-impl
- **Container/presentational split**; Context for low-frequency state only (settings/theme) — never playback
- **Variant types** for async states: `{ type: 'loading' } | { type: 'ready'; data }`
- IndexedDB via `idb`; OPFS for large blobs (models, audio)
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

> "We're between phases — M11 shipped. Read `docs/ROADMAP.md` for direction + the DEFINE→SHIP lifecycle, then start the next effort at `/spec` (it creates `docs/specs/<slug>/spec.md` + `plan.md` + `todo.md`). For established patterns, read a relevant shipped spec under `docs/specs/<slug>/spec.md`."

For TTS work, also read [`docs/spikes/piper-wasm.md`](docs/spikes/piper-wasm.md) (M2 recommendations: pin ORT 1.18.0, mirror wasm locally, single-threaded default, Web Worker, pre-download model to OPFS).

## Non-goals (launch scope)

Cloud TTS/sync/store, accounts, multi-user, native app stores, DRM circumvention. See [`docs/VISION.md`](docs/VISION.md).
