# TaleTrek — Agent Guide

> Free, open-source **reading companion** by **l1br3**: turn any ebook (PDF/EPUB/MOBI/TXT) into an audiobook with on-device neural TTS (Piper, WASM). Ships as an installable, offline-first PWA. No backend, no cloud, MIT-licensed.

## Status

| Milestone | State | Doc |
| --------- | ----- | ---- |
| M0 — Foundation | ✅ **Done** (commit `e9bdd61`) | [`docs/prds/M0-foundation.md`](docs/prds/M0-foundation.md) |
| Piper spike | ✅ Done (thesis proven in-browser) | [`docs/spikes/piper-wasm.md`](docs/spikes/piper-wasm.md) |
| M1 — Upload & Read | ⬜ **Next** | see [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| M2–M5 | Planned | [`docs/ROADMAP.md`](docs/ROADMAP.md) |

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

## How to resume (in a new session)

Open opencode in this repo and say, e.g.:

> "Continue with M1 — Upload & Read. Read `docs/ROADMAP.md` and `docs/prds/M0-foundation.md` for established patterns, then plan M1 following the spec-driven workflow. The Piper integration is M2, not M1."

The agent auto-loads this file + `.opencode/rules/tech.md`. For TTS work, also point it at [`docs/spikes/piper-wasm.md`](docs/spikes/piper-wasm.md) (M2 recommendations: pin ORT 1.18.0, mirror wasm locally, single-threaded default, Web Worker, pre-download model to OPFS).

## Non-goals (launch scope)

Cloud TTS/sync/store, accounts, multi-user, native app stores, DRM circumvention. See `docs/VISION.md`.
