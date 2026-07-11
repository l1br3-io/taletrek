# PRD: M2 — Speak

> **Status:** Ready to implement.
> **Companions:** [`../../VISION.md`](../VISION.md), [`../../ROADMAP.md`](../ROADMAP.md), [`M0-foundation.md`](M0-foundation.md), [`M1-upload-read.md`](M1-upload-read.md), [`../spikes/piper-wasm.md`](../spikes/piper-wasm.md), [`../adr/0002-mit-piper-pipeline.md`](../adr/0002-mit-piper-pipeline.md).

## Objective

Turn the M1 reader into a read-aloud experience: tap play and Piper TTS — a neural speech synthesis engine running entirely in-browser via WebAssembly — synthesizes the book's text per-paragraph inside a Web Worker and plays it through a single `<audio>` element, auto-advancing and highlighting the spoken paragraph as it goes. Choose a curated English voice (downloaded to OPFS on demand), adjust playback speed, and pause or resume at any point. Audio plays inline alongside the reader view so you can follow along visually. This milestone delivers the core text-to-speech experience: your book, spoken aloud, on any device, for free — no cloud calls.

**User story:** *As a reader, I tap play and TaleTrek reads my book aloud, highlighting each paragraph as it speaks. I pick a voice and a speed, and it just works — offline, no cloud, no cost.*

This is **foreground inline playback** (read-along), not background/Jog mode. Background playback, Media Session lock-screen controls, and pre-rendered audio buffers land in **M3**.

## Decisions (locked)

| Area                 | Decision                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Playback granularity | **Per-paragraph** — synthesize one paragraph → `<audio>` Blob URL → advance on `ended`                  |
| Read-along           | Highlight the currently-spoken paragraph; tap a paragraph to seek playback there                       |
| Voice catalog        | **Curated ~8 English voices** (medium quality, locale/gender mix); each downloaded on demand to OPFS   |
| Speed control        | `audio.playbackRate` (`preservesPitch = true`); persisted in settings                                    |
| Threading            | **Single-threaded default** — no COOP/COEP headers (any static host works, including GitHub Pages)      |
| Inference            | Runs in a **Web Worker** (UI thread stays free; survives backgrounding; M3 pre-rendering-ready)        |
| Model storage        | OPFS via the package's `tts.download()` / `tts.stored()` (the package handles caching)                  |
| Playback state       | Lives in the `/reader` **container** (variant types) — **never Context** (per AGENTS.md convention)     |
| Position persistence | **None in M2** — resumes at chapter start each session; reading-position memory is M5's scope          |
| DB schema            | **No bump** — `voiceId` + `playbackRate` ride the existing `settings` store                              |
| Licensing            | ADR-0002 already accepted (MIT pipeline); ADR-0001 GPL is fallback only                                 |

## Technologies (additions to M0/M1)

| Package                       | Version | License | Purpose                                                                                  |
| ----------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `@mintplex-labs/piper-tts-web`  | 1.0.4   | MIT     | On-device neural TTS (Piper) — `voices()`, `download()`, `stored()`, `predict()`          |
| `onnxruntime-web`               | 1.18.0  | MIT     | ONNX runtime — **pinned exactly** (the package hardcodes the wasm to cdnjs@1.18.0; any other JS version deadlocks inference — see AGENTS.md gotcha #1) |

No new dev dependencies. The WASM artifacts (ORT wasm binaries + piper-phonemize data) are **mirrored locally** under `public/wasm/` so the app never depends on cdnjs for inference (offline + reliability). Adding dependencies is ask-first per M0 boundaries; both are MIT and ADR-0002-compliant.

## Domain model (new branded types)

```ts
type VoiceId = string & { readonly __brand: 'VoiceId' }

type VoiceQuality = 'low' | 'medium' | 'high'

interface Voice {
  id: VoiceId
  name: string            // human-readable display name
  quality: VoiceQuality
  sizeBytes: number       // approximate model size, for UI affordance
  language: string        // BCP-47 code, e.g. 'en_US'
}

interface SynthesisRequest {
  text: string
  voiceId: VoiceId
}

interface SynthesisResult {
  audio: Blob             // WAV, 22050 Hz mono 16-bit (per spike)
  synthMs: number         // wall-clock synthesis time, for diagnostics
}

interface TtsEngine {
  listVoices(): Promise<Voice[]>
  isStored(voiceId: VoiceId): Promise<boolean>
  download(voiceId: VoiceId, onProgress?: (fraction: number) => void): Promise<void>
  synththesize(req: SynthesisRequest): Promise<SynthesisResult>
}
```

The `TtsEngine` interface is defined **before** the concrete implementation (per the interface-first convention). The concrete engine wraps `@mintplex-labs/piper-tts-web`. Playback (the `useParagraphPlayer` hook) depends on `TtsEngine`, never on the package directly — so the engine is swappable and testable with a stub.

## Architecture

```
                         ┌──────────────────────────────────────────┐
  SettingsProvider       │  voiceId, playbackRate  (low-frequency)  │
  (Context — settings)   │  persisted in IndexedDB `settings` store │
                         └──────────────────┬───────────────────────┘
                                            │ reads
  /reader container ────────────────────────┼─────────────────────────
  (owns playback state — NEVER Context)     │
    useParagraphPlayer(book, chapters):     │
      pointer → ttsClient.synth({text,id}) ─┘
                 │                ▲  SynthesisResult.audio (Blob)
                 ▼                │
      [TTS Worker: piper predict()]   ← model resident in worker (warm ≈ 0.16× realtime)
                 │                ▲
                 │                │  ort.env.wasm.wasmPaths = '/wasm/*'  (local mirror)
                 │                │  ORT pinned to 1.18.0
      <audio>  src = Blob URL  ──► on 'ended' → advance pointer, revoke prior URL
                                            ▼
      ReaderView: highlight currentParagraphId
```

- Mirrors the **M1 worker/client pattern** (`parse.worker.ts` + `lib/parse/client.ts`): a worker wraps the engine, a typed client promise-wraps it with a message protocol.
- The `/reader` route stays the **container** (owns data + playback state). `ReaderView` and the new `PlayerBar` / `VoicePicker` stay **presentational**.
- Playback state is a **variant type** (the established idiom): `{ type: 'idle' } | { type: 'loading' } | { type: 'playing'; paragraphId } | { type: 'paused'; paragraphId } | { type: 'ended' } | { type: 'error'; message }`.
- A single `<audio>` element lives in the container; the hook imperatively drives `audio.src` / `.play()` / `.pause()` and listens for `ended`.

## Commands

Unchanged from M1 — run at the workspace root:

```
pnpm install              # install deps (adds piper-tts-web + onnxruntime-web)
pnpm dev                  # Vite dev server (web/)
pnpm build                # production build → web/dist
pnpm typecheck            # tsc --noEmit
pnpm lint                 # biome check (spike/ excluded)
pnpm lint:fix             # biome check --write
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build (run before commits)
```

## Project structure (additions under `web/src/`)

```
types.ts                          + VoiceId, Voice, VoiceQuality, SynthesisRequest, SynthesisResult
lib/
  tts/
    types.ts                      TtsEngine interface + the above domain types
    engine.ts                     concrete engine wrapping @mintplex-labs/piper-tts-web
    voices.ts                     curated catalog (~8 English voices, filtered from tts.voices())
    client.ts                     worker promise wrapper (mirrors lib/parse/client.ts)
    protocol.ts                   typed worker message protocol
    *.test.ts                     engine (stubbed package) + catalog tests
  parse/                          (unchanged from M1)
workers/
  tts.worker.ts                   runs predict(); model resident; posts SynthesisResult/error
hooks/
  useParagraphPlayer.ts           pointer + audio element + advance + Blob-URL lifecycle
  useParagraphPlayer.test.ts
components/
  ReaderView.tsx                  + currentParagraphId prop → highlight + onSeekParagraph
  PlayerBar.tsx                   (presentational) play/pause/prev/next + speed control
  VoicePicker.tsx                 (presentational) voice list, download progress, "stored" badge
  *.test.tsx
context/
  settings.tsx                    + voiceId + playbackRate fields (persisted)
routes/
  reader.tsx                      wires useParagraphPlayer; owns playback state
  settings.tsx                    + VoicePicker + speed slider
public/
  wasm/                           mirrored ORT 1.18.0 wasm + piper-phonemize data (offline inference)
```

## Code style

Follows `.opencode/tech/typescript/patterns.md` + `react/patterns.md` and the M0/M1 conventions. Highlights:

- **Strict TS**, branded IDs (`type VoiceId = string & { readonly __brand: 'VoiceId' }`), `import type` for type-only imports (`verbatimModuleSyntax`)
- **Container/presentational split** — `reader.tsx` owns data + playback state; `ReaderView` / `PlayerBar` / `VoicePicker` are pure props
- **Context for low-frequency state only** (settings: theme, fontScale, **voiceId, playbackRate**) — playback state lives in the container, never Context
- **Variant types** for async/machine states: `{ type: 'idle' } | { type: 'loading' } | { type: 'playing'; paragraphId } | ...`
- **Define the contract (interface) before implementing** — `TtsEngine` before the concrete engine; playback depends on the interface, not the package
- No comments unless asked; Biome handles format/import-order (2-space, single quotes, no semicolons, trailing commas)
- **Blob URL hygiene** — every `URL.createObjectURL` has a matching `URL.revokeObjectURL` on advance/unmount (no leaks)

## Testing strategy

- **Engine** (`lib/tts/engine.test.ts`): the package is stubbed/mocked; tests assert `listVoices`/`isStored`/`download`/`synththesize` map correctly to the package API and return typed results.
- **Voice catalog** (`lib/tts/voices.test.ts`): snapshot the curated IDs; assert all are English + medium quality; assert the catalog is non-empty and deduped.
- **Worker client** (`lib/tts/client.test.ts`): mocked worker — resolves on success, rejects on error path (mirrors `lib/parse/client.test.ts`).
- **`useParagraphPlayer`** (`hooks/useParagraphPlayer.test.ts`): stubbed synth function — pointer advancement, auto-advance on `ended`, `seekToParagraph`, prev/next, **Blob URL revocation on advance**, status-variant transitions. Audio-element interaction is abstracted behind an injectable boundary so tests don't need a real `<audio>`.
- **Components**: `PlayerBar` play/pause/prev/next/speed; `VoicePicker` download-progress + stored-badge states; `ReaderView` highlight-on-`currentParagraphId` + seek-on-click; settings persist voice + rate.
- **Browser**: chrome-devtools MCP — upload a book, play through a chapter with highlighting, download + switch a voice, change speed, verify zero cdnjs calls, verify offline playback after model cached, zero console errors.
- **Coverage target:** `lib/tts/` + `hooks/useParagraphPlayer` >80% (per M0); the concrete package is mocked, not exercised, in unit tests (real inference is verified in T3 + T7 via the browser).

## Boundaries

- **Always:** `pnpm typecheck && pnpm test && pnpm lint` green before considering a task done; validate inputs at module boundaries; define interfaces before implementing; revoke every Blob URL.
- **Ask first:** adding dependencies beyond the two listed; changing the IndexedDB schema version; modifying CI config; touching `vite-plugin-pwa` strategy.
- **Never:** commit secrets or large binary models (models download to OPFS at runtime, not committed); disable strict TS; depend on a CDN at runtime (wasm is mirrored locally); put playback state in Context; delete a failing test to make CI pass.

## Success criteria (testable)

1. Tap play on an uploaded book → Piper synthesizes and audio plays inline within the reader.
2. The currently-spoken paragraph is **highlighted**; on paragraph end, playback advances and the highlight follows.
3. Tap any paragraph → playback seeks there and resumes.
4. Pause and resume work; playback state is recoverable mid-chapter.
5. A curated voice can be **downloaded** (with progress indicator) and **selected**; selecting switches the active voice.
6. Playback speed is adjustable (0.5×–2×) and applies live; the chosen speed + voice **persist across reload**.
7. Once a voice is downloaded, playback works **fully offline** (no network calls during inference).
8. `pnpm verify` (lint + typecheck + test + build) is green.
9. chrome-devtools MCP run: **zero console errors**; **zero cdnjs network requests**; play → advance → highlight → voice switch → speed change all work; offline playback after model cached.

## Risks (tracked, not blocking)

| Risk                                                                       | Mitigation                                                                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ORT version mismatch deadlocks inference** (AGENTS #1)                       | Exact pin `onnxruntime-web@1.18.0`; mirror wasm locally under `public/wasm/`; T1 verifies **zero cdnjs requests** in the network tab                         |
| **`piper-tts-web` OPFS-from-worker unverified** (spike ran on the main thread)  | T3 verifies OPFS `download`/`stored` from inside the worker early; fallback: run the engine on the main thread behind the same `TtsEngine` interface if worker OPFS breaks |
| **Cold-synth latency ≈ 4.3s** (spike)                                         | "Loading voice…" state on first play; warm synth is ≈1.1s — acceptable per-paragraph; subsequent paragraphs are fast                                       |
| **Blob URL memory leaks**                                                     | `useParagraphPlayer` revokes the prior URL on every advance and on unmount; covered by unit test                                                            |
| **Safari 7-day ITP evicts OPFS models** (AGENTS #2)                           | Models are re-downloadable on demand; the uploaded book file remains the source of truth; `navigator.storage.persist()` already requested in M0            |
| **`piper-tts-web` lightly maintained** (ADR-0002)                             | Pin both packages; mirror wasm locally so we control runtime artifacts; the package is MIT — forkable if it rots                                          |
| **Bundle size** (`piper-tts-web` + ORT wasm)                                  | Piper is isolated in the worker chunk — Vite code-splits workers; main bundle unaffected; wasm served from `public/` (not inlined)                         |
| **Single-threaded perf unverified on low-end mobile**                         | Spike measured multi-threaded at 0.16× realtime; even 2–4× slower single-threaded stays faster-than-realtime (0.3–0.6×); revisit if real hardware struggles  |
| **Worker-safe package**                                                       | T3 confirms the package loads in a worker; if not, fall back to a main-thread engine behind the `TtsEngine` interface (still off the critical path post-paint) |

## Tasks (ordered, dependency-chained)

| #   | Task                              | Acceptance                                                                                                                                                                                                | Verify                                                                                       | Files                                                                                                        |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| T1  | Deps + local WASM mirror          | `@mintplex-labs/piper-tts-web@1.0.4` + `onnxruntime-web@1.18.0` installed (exact pin); ORT wasm + piper-phonemize data mirrored under `public/wasm/`; `wasmPaths` overridden to local; dev server loads with **zero cdnjs calls** | network tab in browser: no `cdnjs.cloudflare.com` requests                                    | `web/package.json`, `web/public/wasm/*`, engine config                                                          |
| T2  | TTS types + curated voice catalog | `TtsEngine` interface + `Voice`/`VoiceId`/`SynthesisRequest`/`SynthesisResult` types; curated ~8 English voices filtered from `tts.voices()` (medium quality, locale/gender mix); catalog non-empty + deduped    | catalog snapshot test                                                                         | `types.ts` (additions), `lib/tts/{types,voices}.ts`, `lib/tts/voices.test.ts`                                    |
| T3  | TTS Worker + client               | Worker wraps `predict()` (model resident); client promise-wraps with typed protocol; `SynthesisResult.audio` returned as transferable Blob; **OPFS `download`/`stored` verified from inside the worker**     | client test (mocked worker) + manual: synth one sentence from the dev server (real WAV plays) | `workers/tts.worker.ts`, `lib/tts/{client,protocol}.ts`, `lib/tts/client.test.ts`                                |
| T4  | Paragraph playback hook           | `useParagraphPlayer(book, chapters)` exposes play/pause/stop/next/prev/seekToParagraph; auto-advances on `ended`; **revokes prior Blob URL on every advance**; exposes `currentParagraphId` + status variant | unit test pointer/queue/revocation with a stubbed synth fn                                   | `hooks/useParagraphPlayer.ts`, `hooks/useParagraphPlayer.test.ts`                                              |
| T5  | Reader read-along UI              | Play/pause button; current-paragraph highlight; tap-paragraph-to-seek; "loading voice…"/synthesizing state for cold first-synth; `ReaderView` + `PlayerBar` presentational, container owns playback          | component tests (play/pause/advance/highlight/seek)                                          | `routes/reader.tsx`, `components/{ReaderView,PlayerBar}.tsx`, tests                                              |
| T6  | Settings: voice + speed           | `VoicePicker` (curated list, download progress %, "downloaded" badge via `isStored`); `playbackRate` slider (0.5×–2×); both fields added to `Settings` + persist via `SettingsProvider`                       | settings test (persist + download flow with mocked engine)                                   | `context/settings.tsx`, `routes/settings.tsx`, `components/VoicePicker.tsx`, tests                              |
| T7  | End-to-end + browser verify       | Upload book → play → auto-advances through a chapter with highlight; voice download + switch works; speed change applies live; **offline playback** after model cached; zero console errors; `pnpm verify` green | chrome-devtools MCP run + full `pnpm verify`                                                  | wiring + minor fixes                                                                                          |

**Ordering:** T1 → T2 → T3 → T4 → (T5 ∥ T6) → T7.

**Checkpoints:** A (T1–T3: engine + worker proven) · B (T4: playback engine works) · C (T5–T6: full read-along slice) · D (T7: shipped, verify green).

## Out of scope (later milestones)

Background/Jog mode, Media Session lock-screen controls, and pre-rendered audio-chunk buffers ahead of playback position (M3); the configurable text-cleaning pipeline that strips links/images/footnotes/pronunciation dictionary (M4); the full library view, reading-position persistence (resume-where-you-left-off), cached-model management UI, and PWA polish (M5).
