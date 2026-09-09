# TaleTrek — Agent Guide

> Free, open-source **reading companion** by **l1br3**: turn any ebook or document into an audiobook with OSS neural TTS (sherpa-onnx — Piper + Kokoro voices) running in-process in a Rust kernel. Platform-native apps (desktop processor → Android → iOS) behind UniFFI, free store downloads; the web is a landing page + `.taletrek` reader. No backend, no cloud, MIT-licensed.

## Current effort

**Efforts 1–4 shipped — the kernel lives on a phone too.** `native-pivot` re-founded the repo on the Rust-kernel direction (decision: [ADR-0015](docs/adrs/0015-native-pivot-rust-kernel-and-native-apps.md); the why + locked stack: [`docs/ideas/native-pivot.md`](docs/ideas/native-pivot.md)). `kernel-parse` built the ingest front door: `crates/parse` + `taletrek-desktop parse --input <doc>` → text-only `.taletrek`, chained `synth --input <doc>` → full audio bundle. `desktop-synth-gui` gave the kernel a face and removed its external binaries: in-process sherpa-onnx TTS (`SherpaRunner`, feature `sherpa`) + native Opus encode (`NativeOpusEncoder`, feature `native-encode`) are the defaults (subprocess `--piper`/`--ffmpeg` stay as overrides), an egui GUI (`gui` subcommand; bare run opens it) turns documents into bundles via a job queue with voice picker/catalog download, and a tag push builds release artifacts. Then `desktop-reader-page` taught it to read back; `android-app` crossed the kernel to a phone: `crates/ffi` (UniFFI → checked-in Kotlin) + `android/` (Compose library ⇄ reader, Media3 `MediaSessionService` — the Jog bar: lock-screen audio, notification chapter controls, corrupt-segment skip tolerance, DataStore positions; release job builds a signed AAB + universal APK). Specs: [`native-pivot`](docs/specs/native-pivot/spec.md) · [`kernel-parse`](docs/specs/kernel-parse/spec.md) · [`desktop-synth-gui`](docs/specs/desktop-synth-gui/spec.md) · [`desktop-reader-page`](docs/specs/desktop-reader-page/spec.md) · [`android-app`](docs/specs/android-app/spec.md). Next effort: `ios-app` (the same `crates/ffi` surface via UniFFI's Swift target) — see [`docs/ROADMAP.md`](docs/ROADMAP.md).

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

# Rust (run from repo root) — desktop app (GUI + CLI) + shared crates
cargo build --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test --workspace -- --ignored    # real piper+ffmpeg+sherpa; needs TALETREK_VOICE_PATH — see docs/testing.md
just gui                               # run the desktop GUI (egui)
# Android (SDK/NDK prereqs — docs/developing.md § Android)
just android                           # kernel .so + gradle assembleDebug → APK
just android-test                      # Kotlin JVM unit tests + ktlint (headless)
just android-instrumented              # on-device suites (needs adb hardware)
```

Workspace: pnpm + cargo + gradle. `web/` (landing + reader) + `spike/{piper,web-audio}/` (throwaway de-risking apps) on Node 24 / pnpm 10.31.0; `desktop/` + `crates/{parse,reader,synth,worker,ffi}/` on Rust 1.97.0; `android/` on Gradle 9.7/AGP 9.4/Kotlin 2.4 (see [`docs/testing.md`](docs/testing.md) + [`docs/developing.md`](docs/developing.md) § Android for the full test matrix).

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
desktop/           the kernel app — Rust + clap + egui (binary taletrek-desktop;
                    gui subcommand / bare run = windowed converter + reader; CLI: parse +
                    synth + resynth — source → bundle → audio)
  src/gui/         eframe app: pure queue state machine + executor + views +
                    reader screen; egui never appears outside this dir
  src/gui/reader/  the read-back half: session open flow, egui screen, sync UX,
                    playback controller, cpal+symphonia engine, position store
                    (sequencing itself lives in crates/reader — never here)
android/           the Android player — hand-rolled Gradle + Compose + Media3
                    (single activity; library ⇄ reader; MediaSessionService for
                    background playback; UniFFI Kotlin checked in under app/…/ffi/)
crates/ffi/        the kernel's foreign surface (taletrek-ffi): UniFFI wrappers over
                    reader+synth default features — openBook/readSegment/TrekPlayer;
                    zero logic; Kotlin now, Swift in effort 5
.github/workflows/ ci.yml (gates) + release.yml (tag v* → per-target release
                    artifacts — see docs/releasing.md)
crates/parse/      the ingest core: format detect + per-format parsers + M4 clean
                    (bytes in → ParsedBook out → text-only bundle; UniFFI-ready pure data)
crates/reader/     the read-side core: BookIndex + PlayerState sequencer + Position
                    (manifest+text in → navigable book + pure playback sequencing;
                    UniFFI-ready, zero UI/audio deps — desktop/Android/iOS consume it)
crates/synth/      shared pure core: bundle I/O, synth, encode, cache_key (the interchange format);
                    engine impls behind features — sherpa_runner.rs (`sherpa`),
                    opus_native.rs (`native-encode`), subprocess piper/ffmpeg stay
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
30. **Clean-idempotence is a cross-app invariant — parse output must survive the reader's `cleanChapters` unchanged** — [`G30`](docs/gotchas.md#g30)

## How to resume (in a new session)

Open opencode in this repo and say, e.g.:

> "Current effort is `ios-app` — read `docs/specs/ios-app/spec.md` + `todo.md`, then run `/build` for the next pending task. Direction: `docs/ROADMAP.md` (native track, ADR-0015)."

## Non-goals (product)

Cloud TTS/sync/store, accounts, multi-user, DRM circumvention. Store distribution **is** the model now (free downloads); sync/cloud return only via a future ADR. See [`docs/VISION.md`](docs/VISION.md).
