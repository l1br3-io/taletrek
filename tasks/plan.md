# M2 — Speak · Plan

> Per-task detail for [`todo.md`](./todo.md). Spec: [`docs/prds/M2-speak.md`](../docs/prds/M2-speak.md).
> Ordering: T1 → T2 → T3 → T4 → (T5 ∥ T6) → T7.

## Resuming

**As of 2026-07-11:** M1 — Upload & Read is **shipped** at commit `71a642b finished M1`
(includes the T8 MOBI spike). `pnpm verify` green at M1 close: lint ✅, typecheck ✅,
test ✅ (64 tests / 10 files), build ✅. Clean working tree.

**M2 scope locked** (see PRD decisions table + the four trade-off answers):
per-paragraph synthesis with read-along highlight + tap-to-seek; curated ~8 English
voices (medium quality) downloaded on demand to OPFS; `audio.playbackRate` for speed;
single-threaded default (no COOP/COEP); inference in a Web Worker; **no DB schema bump**
(voice + speed ride the `settings` store); **no position persistence** (M5).

**Licensing:** ADR-0002 already accepted (MIT pipeline via
`@mintplex-labs/piper-tts-web`); ADR-0001 GPL is fallback only. The spike
(`docs/spikes/piper-wasm.md`) proved the thesis: warm synth ≈ 0.16× realtime, faster
than realtime even single-threaded. Spike API surface: `tts.voices()`,
`tts.download(id, cb)` → OPFS, `tts.stored()`, `tts.predict({text, voiceId})` → WAV Blob.

**Critical reminders (do not relearn):**
1. Pin `onnxruntime-web@1.18.0` **exactly** — any other JS version deadlocks inference silently (AGENTS #1). Mirror the wasm locally; verify zero cdnjs calls.
2. The spike ran `piper-tts-web` on the **main thread**. M2 runs it in a **Web Worker** — OPFS-from-worker must be verified in T3 (the package's `download`/`stored` use OPFS). Fallback: main-thread engine behind the same `TtsEngine` interface.
3. Revoke every Blob URL (advance + unmount) — `useParagraphPlayer` owns this; covered by unit test.
4. Playback state stays in the `/reader` container (variant types) — **never Context**. Only `voiceId` + `playbackRate` go in `SettingsProvider` (low-frequency).

---

## Tasks

### T1 — Deps + local WASM mirror
- **Detail:** Install `@mintplex-labs/piper-tts-web@1.0.4` + `onnxruntime-web@1.18.0` (exact pin). Mirror the ORT wasm binaries + piper-phonemize data into `web/public/wasm/`. Configure the engine so `ort.env.wasm.wasmPaths` points at the local mirror (overriding the package's cdnjs default). Verify the dev server loads the package and the network tab shows **zero `cdnjs.cloudflare.com` requests**.
- **Depends on:** — (foundation; no code depends on it yet).
- **Acceptance:** both deps installed with exact versions; `public/wasm/` populated; engine configured; browser network tab clean of cdnjs during a smoke load.
- **Verify:** manual browser check (dev server) — no cdnjs requests.
- **Files:** `web/package.json`, `web/public/wasm/*`, engine config wiring.

### T2 — TTS types + curated voice catalog
- **Detail:** Branded `VoiceId` + `Voice`/`VoiceQuality`/`SynthesisRequest`/`SynthesisResult` types (interface-first). Define the `TtsEngine` interface **before** the concrete engine. Build the curated catalog: filter `tts.voices()` for English (`language.code` starts with `en`), `medium` quality, hand-pick ~8 across locales + perceived gender; capture real IDs (do not hardcode unverified names). Provide display names + size estimates.
- **Depends on:** T1 (package installed so `tts.voices()` is callable to capture IDs).
- **Acceptance:** `TtsEngine` interface defined; catalog non-empty, deduped, all English + medium; snapshot test pins the curated IDs.
- **Verify:** `lib/tts/voices.test.ts`.
- **Files:** `web/src/types.ts` (additions), `web/src/lib/tts/{types,voices}.ts`, `web/src/lib/tts/voices.test.ts`.

### T3 — TTS Worker + client
- **Detail:** `workers/tts.worker.ts` wraps `tts.predict()` with the model resident in the worker; `lib/tts/client.ts` is a promise wrapper with a typed protocol (mirrors `lib/parse/{client,protocol}.ts`). The worker returns `SynthesisResult.audio` (WAV Blob). **Verify OPFS works from inside the worker** — call `tts.download()` + `tts.stored()` from the worker and confirm a model lands in OPFS. If worker-OPFS breaks, fall back to a main-thread engine behind the same `TtsEngine` interface and record the deviation here.
- **Depends on:** T1, T2 (types + package).
- **Acceptance:** client resolves on success, rejects on error path; manual smoke: synth one sentence from the dev server and hear real audio; OPFS-from-worker confirmed (or deviation recorded).
- **Verify:** `lib/tts/client.test.ts` (mocked worker); manual dev-server synth.
- **Files:** `web/src/workers/tts.worker.ts`, `web/src/lib/tts/{client,protocol}.ts`, `web/src/lib/tts/client.test.ts`.

Checkpoint A — Engine + worker proven (synthesize WAV from worker, offline-ready) · ☐

### T4 — `useParagraphPlayer` hook
- **Detail:** The chunk-queue predecessor to M3's pre-rendering. Flattens the book's chapters into a paragraph list with stable IDs; keeps a pointer; on `play` synthesizes the current paragraph via the worker client, creates a Blob URL, sets it on a single `<audio>` element, and plays. On `ended`, advances the pointer and synthesizes the next. Exposes `play`/`pause`/`stop`/`next`/`prev`/`seekToParagraph`, `currentParagraphId`, and a status variant `{ idle | loading | playing | paused | ended | error }`. **Revokes the prior Blob URL on every advance and on unmount.** Audio-element interaction is abstracted behind an injectable boundary so unit tests don't need a real `<audio>`.
- **Depends on:** T3 (worker client).
- **Acceptance:** pointer advancement correct; auto-advance on `ended`; `seekToParagraph` jumps; prev/next cross chapter boundaries; **no Blob URL leak** (revocation asserted); status-variant transitions correct.
- **Verify:** `hooks/useParagraphPlayer.test.ts` (stubbed synth fn + fake audio boundary).
- **Files:** `web/src/hooks/useParagraphPlayer.ts`, `web/src/hooks/useParagraphPlayer.test.ts`.

Checkpoint B — Playback engine works (play a book, auto-advance through paragraphs) · ☐

### T5 — Reader read-along UI
- **Detail:** Wire `useParagraphPlayer` into the `/reader` container; the container owns playback state (variant types). `ReaderView` gains a `currentParagraphId` prop to highlight the spoken paragraph and an `onSeekParagraph(id)` callback for tap-to-seek — stays presentational. New `PlayerBar` (presentational): play/pause, prev/next, and the speed control (read from settings). Show a "loading voice…" / synthesizing state for cold first-synth (~4.3s) and brief inter-paragraph synth (~1s warm).
- **Depends on:** T4 (hook).
- **Acceptance:** component tests cover play/pause/advance/highlight/seek; `ReaderView` + `PlayerBar` remain props-only.
- **Verify:** component tests.
- **Files:** `web/src/routes/reader.tsx`, `web/src/components/{ReaderView,PlayerBar}.tsx`, tests.

### T6 — Settings: voice + speed
- **Detail:** Add `voiceId` + `playbackRate` to `Settings` (default: first catalog voice, rate 1); persist via `SettingsProvider` (low-frequency → Context is correct). New `VoicePicker` (presentational): curated voice list, per-voice download with progress %, and a "downloaded" badge from `isStored`. Speed slider 0.5×–2× bound to `playbackRate`. `Settings` route renders both.
- **Depends on:** T2 (catalog), T3 (engine for `download`/`isStored`). Parallel to T5.
- **Acceptance:** settings test persists voice + rate across reload (fake-indexeddb); `VoicePicker` download flow tested with a mocked engine.
- **Verify:** `routes/settings.test.tsx` (extended), `components/VoicePicker.test.tsx`.
- **Files:** `web/src/context/settings.tsx`, `web/src/routes/settings.tsx`, `web/src/components/VoicePicker.tsx`, tests.

Checkpoint C — Full slice: upload → read → play → read-along, voice + speed wired · ☐

### T7 — End-to-end + browser verify
- **Detail:** Upload a book → play → auto-advances through a chapter with the highlight following; tap a paragraph → seeks; download a second voice → switch → voice changes; adjust speed → applies live; reload → voice + speed persist; go offline after the model is cached → playback still works. Zero console errors; zero cdnjs network requests.
- **Depends on:** T1–T6 (full slice).
- **Acceptance:** `pnpm verify` green; chrome-devtools MCP run clean (zero console errors, zero cdnjs, offline playback after model cached).
- **Verify:** full `pnpm verify` green; MCP browser run.
- **Files:** wiring + minor fixes across the slice.

Checkpoint D — Speak slice shipped & `pnpm verify` green · ☐

---

## Deviations
*(empty — record any here as they occur, with a numbered entry and a "read before continuing" note.)*
