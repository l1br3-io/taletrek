# TaleTrek — Agent Guide

> Free, open-source **reading companion** by **l1br3**: turn any ebook or document into an audiobook with OSS neural TTS (sherpa-onnx — Piper + Kokoro voices) running in-process in a Rust kernel. Platform-native apps (desktop processor → Android → iOS) behind UniFFI, free store downloads; the web is a landing page + `.taletrek` reader. No backend, no cloud, MIT-licensed.

## Current effort

**Active — `native-pivot`** (effort 1 of the native track, started 2026-08-30): the purge + re-foundation — the personal server is deleted entirely, the SPA is scoped down to a reader + landing page, and the docs re-tell the native story. Decision: [ADR-0015](docs/adrs/0015-native-pivot-rust-kernel-and-native-apps.md) (deletes ADR-0014, narrows ADR-0013 to bundle format + desktop synth) · the why + locked stack: [`docs/ideas/native-pivot.md`](docs/ideas/native-pivot.md) · spec: [`docs/specs/native-pivot/spec.md`](docs/specs/native-pivot/spec.md) (runbook + todo live there). Next efforts: `kernel-parse` → `desktop-synth-gui` → `android-app` → `ios-app` — see [`docs/ROADMAP.md`](docs/ROADMAP.md).

Live status always lives in the current effort's `spec.md` frontmatter (`status:`) + `todo.md` — **not here**.

- Ship history: [`CHANGELOG.md`](CHANGELOG.md) · Direction + lifecycle: [`docs/ROADMAP.md`](docs/ROADMAP.md)

**Read first:** [`docs/VISION.md`](docs/VISION.md) (the why) → [`docs/ROADMAP.md`](docs/ROADMAP.md) (direction + the DEFINE→SHIP lifecycle) → the current effort's `docs/specs/<slug>/spec.md` (when one is active). For established patterns, read a relevant shipped spec under [`docs/specs/`](docs/specs/).

## Commands

`just --list` shows all dev tasks (dev-web / synth / resynth / test-e2e…) — see [`docs/developing.md`](docs/developing.md). Raw equivalents:

```
pnpm install              # install all workspace deps
pnpm dev                  # Vite dev server (web/, :8253)
pnpm build                # production build → web/dist
pnpm preview              # serve built dist
pnpm typecheck            # tsc --noEmit
pnpm lint                 | biome check (spike/ excluded)
pnpm lint:fix             # biome check --write
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build (run before commits)
pnpm -C spike/piper dev       # Piper spike app on :5174 (throwaway)
pnpm -C spike/web-audio dev   # Web Audio mobile-engine spike on :5175 (throwaway)

# Rust (run from repo root) — desktop CLI + shared crates
cargo build --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test --workspace -- --ignored    # real piper+ffmpeg; needs TALETREK_VOICE_PATH — see docs/testing.md
```

Workspace: pnpm + cargo. `web/` (landing + reader) + `spike/{piper,web-audio}/` (throwaway de-risking apps) on Node 24 / pnpm 10.31.0; `desktop/` + `crates/{synth,worker}/` on Rust 1.97.0 (see [`docs/testing.md`](docs/testing.md) for the full test matrix).

## Layout

```
docs/
  VISION.md       narrative "why" (amended by ADR-0015)
  ROADMAP.md      native track + milestone history + DEFINE→SHIP lifecycle
  ideas/          native-pivot one-pager (the why + locked stack)
  specs/          one dir per effort: <slug>/{spec.md, plan.md, todo.md, tasks/00N-*.md}
                  spec.md frontmatter carries lifecycle: status draft|active|shipped|abandoned
  adrs/           immutable decisions (supersede via a new ADR only)
  gotchas.md      runtime gotchas (G1…; 17 retired in place by the pivot — IDs stay stable)
web/              the web app — landing page + `.taletrek` reader (Vite 8 + React 19 + TS + RR8 + Tailwind v4 + Biome)
  src/
    routes/         landing, library (imported bundles), reader, settings, not-found (+ tests)
    components/     Layout, Nav (presentational)
    context/        settings.tsx (SettingsProvider — low-freq Context)
    hooks/          useSetting
    lib/            db/ (idb), storage.ts (persist), media-session.ts,
                    bundle/ (import/export — the .taletrek interchange),
                    audio/ + playback/ (Web Audio default, FFmpeg fallback — ADR-0010),
                    audio-cache.ts, clean/, tts/ (normalize + unavailable-engine stub),
                    datasource/ (local), backup.ts
spike/piper/       throwaway Piper TTS validation app
spike/web-audio/   throwaway Web Audio mobile-engine spike
desktop/           the headless synth CLI — Rust + clap (binary taletrek-desktop; synth + resynth;
                   gains file→bundle at kernel-parse)
crates/synth/      shared pure core: bundle I/O, synth, encode, cache_key (the interchange format)
crates/worker/     shared host-level: voice acquire + rayon pool + manifest stamping
```

## Conventions

- **Strict TS**, branded IDs, interfaces-before-impl
- **Container/presentational split**; Context for low-frequency state only (settings/theme) — never playback
- **Variant types** for async states: `{ type: 'loading' } | { type: 'ready'; data }`
- IndexedDB via `idb`; OPFS for large blobs (audio)
- Tests co-located (`*.test.tsx`), Vitest + Testing Library + fake-indexeddb
- No comments unless asked; Biome handles format/import-order
- **Icons: [`lucide-react`](https://lucide.dev) (tree-shaken ESM, `stroke="currentColor"`).** Import each icon by name (`import { Play } from 'lucide-react'`) — never import the whole lib. Decorative icons are auto-`aria-hidden`; the button's `aria-label`/visible text is the accessible name. Size via Tailwind: `h-4 w-4` inline with `text-sm`, `h-5 w-5` standalone/FAB; color flows from the button's `text-*` token (never hard-coded). The `❯~` brand mark in `Nav.tsx` stays as ASCII (not an icon).

## Critical gotchas (index)

Full detail lives in [`docs/gotchas.md`](docs/gotchas.md) — **read the relevant entry on demand** before touching that area. The titles below are your scan list; if your task touches the named area, open the link. Survivors only — 17 of the original 29 were retired in place by the native pivot; gaps in numbering are intentional, never renumber.

2. **Safari ITP deletes script storage after 7 days** — [`G2`](docs/gotchas.md#g2)
3. **Dev Service Worker caches stale bundles** — [`G3`](docs/gotchas.md#g3)
4. **License is MIT (ADR-0002); GPL is fallback-only** — [`G4`](docs/gotchas.md#g4)
5. **iOS lock-screen background playback needs real-hardware verification** — [`G5`](docs/gotchas.md#g5)
10. **iOS Safari MSE is `<video>`-only** — [`G10`](docs/gotchas.md#g10)
11. **FFmpeg WASM core ~30 MB, single-threaded only** — [`G11`](docs/gotchas.md#g11)
12. **SourceBuffer.appendBuffer is async — no overlapping appends (dormant browser-fact)** — [`G12`](docs/gotchas.md#g12)
13. **`<video>` pauses on iOS lock screen — accepted limitation** — [`G13`](docs/gotchas.md#g13)
22. **Pluggable playback engines — Web Audio default, FFmpeg fallback; no re-synth post-pivot (cache-miss = explicit error)** — [`G22`](docs/gotchas.md#g22)
23. **Web Audio scheduler: setInterval not rAF; re-anchor on seek** — [`G23`](docs/gotchas.md#g23)
27. **Bundle import loads whole archive into memory (jszip)** — [`G27`](docs/gotchas.md#g27)
28. **`sourceFormat: "unknown"` maps to `'txt'` on import** — [`G28`](docs/gotchas.md#g28)

## How to resume (in a new session)

Open opencode in this repo and say, e.g.:

> "Current effort is `native-pivot` — read `docs/specs/native-pivot/spec.md` + `todo.md`, then run `/build` for the next pending task. Direction: `docs/ROADMAP.md` (native track, ADR-0015)."

## Non-goals (product)

Cloud TTS/sync/store, accounts, multi-user, DRM circumvention. Store distribution **is** the model now (free downloads); sync/cloud return only via a future ADR. See [`docs/VISION.md`](docs/VISION.md).
