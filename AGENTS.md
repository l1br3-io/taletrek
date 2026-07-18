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
| M6 — AI Transforms | ✅ **Done** (cloud-only after ADR-0005; in-browser WebLLM backend removed. cleanup/translate/summarize/simplify/pronunciation-hints, per-paragraph transforms + importable key/config) | [`docs/prds/M6-ai-transforms.md`](docs/prds/M6-ai-transforms.md) · [`docs/adr/0005-remove-in-browser-llm-backend.md`](docs/adr/0005-remove-in-browser-llm-backend.md) · [`tasks/todo.md`](tasks/todo.md) |
| M6.1 — Biometric Key Caching | ✅ **Done** (opt-in WebAuthn PRF tier on top of M6's in-memory default; encrypted blob in IDB wrapped via passkey-derived KEK. Default behaviour unchanged; auto-falls-back where PRF unsupported. ADR-0007 augments ADR-0004.) | [`docs/adr/0007-biometric-key-caching.md`](docs/adr/0007-biometric-key-caching.md) · [`tasks/plan-m6.1-biometric-keys.md`](tasks/plan-m6.1-biometric-keys.md) |
| M7 — Reader UX & Mobile | ✅ **Done** (responsive layout + nav drawer, chapter outline, minimized `⋯` playback menu, go-to-current + FAB, auto-scroll to resumed position on first Play) | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| M8 — Audio Cache | ✅ **Done** (content-addressed IndexedDB audio cache, LRU-bounded ~500 MB, per-book cascade clear, Settings indicator + Clear button) | [`docs/prds/M8-audio-cache.md`](docs/prds/M8-audio-cache.md) |
| M8.1 — iOS Huge-Book Upload Resilience | ✅ **Done** (no WAV round-trip to main thread; active book pinned during upload; mobile encode skipped above ~200 MB; transient storage errors keep the book + offer retry) | [`tasks/plan-m8.1-ios-upload-resilience.md`](tasks/plan-m8.1-ios-upload-resilience.md) |
| M9 — Mobile Streaming Playback | 📋 **Planned** (docs complete, implementation not started. MSE on hidden `<video>`, FFmpeg WASM-encoded fMP4 segments, per-paragraph streaming. Desktop unchanged. ADR-0006.) | [`docs/prds/M9-mobile-streaming.md`](docs/prds/M9-mobile-streaming.md) · [`docs/adr/0006-mobile-mse-streaming.md`](docs/adr/0006-mobile-mse-streaming.md) |

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

## Critical gotchas (do not relearn these)

1. **`onnxruntime-web` must be pinned to `1.18.0`** — `@mintplex-labs/piper-tts-web` hardcodes the ORT wasm to cdnjs@1.18.0; any other JS version deadlocks inference silently. Mirror the wasm locally for M2 (see spike doc).
2. **Safari deletes script storage after 7 days of no interaction (ITP).** Design cached models/audio as re-hydratable; call `navigator.storage.persist()`. The original uploaded file is source of truth.
3. **Dev SW caches stale bundles** — when verifying source changes in-browser, unregister the SW or test via `pnpm preview` (production build) + hard reload.
4. **License: fully MIT** (ADR-0002). The GPL option (ADR-0001) is fallback-only. Do not re-litigate unless the MIT package breaks.
5. **iOS lock-screen background playback is NOT yet verified on real hardware** — the desktop MCP can't test it. Validate on a real iPhone before M3 commits to it.
6. **Web Workers have no `DOMParser`.** The EPUB parser runs inside the parse worker, so it uses `fast-xml-parser` (worker-safe), not the DOM. Any future parsing that needs a DOM must stay on the main thread or use a worker-safe parser. Unit tests can't catch this (jsdom has DOMParser) — only a real browser run does.
7. **`pdfjs-dist` is lazy-imported inside `parse()`** — importing it at module top-level pulls `DOMMatrix` at load, which crashes jsdom. Keep the dynamic `await import('pdfjs-dist')` in `pdf.ts`.
8. **Send file *bytes*, not the `File`, to a worker.** `parseInWorker` reads `file.arrayBuffer()` on the main thread and transfers the `ArrayBuffer`; the worker reconstructs the `File`. Cloning a `File` across the worker boundary can fail for files backed by a filesystem path.
9. **WebGPU is no longer used** — the on-device WebLLM backend was removed (ADR-0005); AI transforms are cloud-only now. The old `requestAdapter()` feature-detect / Flatpak-Vulkan guidance no longer applies.
10. **iOS Safari MSE is `<video>`-only** (ADR-0006 / M9). `MediaSource` + `SourceBuffer` work on `<video>` elements but **not** on `<audio>`. The mobile streaming engine uses a hidden `<video>` (`display: none`). fMP4 segments must include a video track (1x1 black H.264 frame) — audio-only fMP4 may be rejected by iOS Safari's MSE parser. Future optimization: drop the video track if audio-only is proven safe.
11. **FFmpeg WASM core is ~30MB and single-threaded** (ADR-0006 / M9). The `@ffmpeg/core` WASM is downloaded to OPFS on first mobile playback (like Piper voice models), then loaded from OPFS on subsequent uses. **Do not** use the multi-threaded core (`@ffmpeg/core-mt`) — it requires `SharedArrayBuffer` which forces cross-origin isolation (COOP/COEP) headers on the entire app. Single-threaded is fast enough for encoding short speech clips.
12. **`SourceBuffer.appendBuffer` is async — no overlapping appends.** Wait for the `updateend` event before calling `appendBuffer` again. Use `SourceBuffer.timestampOffset` to position each segment at the correct time in the timeline. Read cumulative duration from `sourceBuffer.buffered.end(ranges.length - 1)` after each append.
13. **`<video>` elements pause on iOS lock screen** (ADR-0006 / M9). This is an accepted limitation of the mobile streaming engine. The user taps play to resume from their position. Do not attempt workarounds — the per-paragraph `<audio>` approach (desktop) fails entirely on lock, which is worse.
14. **WebAuthn PRF cannot be unit-tested in jsdom** (ADR-0007 / M6.1). `secure-keyring.test.ts` mocks `crypto/prf` to control the biometric flow; the AES round-trip + IDB persistence run for real. Real-device verification requires a browser + authenticator that supports the PRF extension (Chrome/Edge yes, Safari 18+, Firefox partial; platform authenticators like Touch ID / Windows Hello work, as do FIDO2 security keys like YubiKey). The `BiometricKeyringSection` returns `null` on unsupported browsers — that fallback is the contract, not a bug. Don't add a master-passphrase fallback tier; ADR-0007 explicitly rejected it as weaker than PRF-where-supported + silent-fallback-to-in-memory.
15. **`crypto.subtle` is a built-in browser API, not a network call** (ADR-0007 / M6.1). The existing CSP `connect-src` allowlist doesn't need to be touched for AES-GCM or WebAuthn — neither makes a fetch. CSP remains the primary exfiltration defence for an *unlocked* key; PRF is defense-in-depth for the *at-rest* blob only.
16. **The wrapped-DEK pattern is load-bearing** (ADR-0007 / M6.1). `secure-keyring.ts` deliberately wraps a random DEK with a PRF-derived KEK rather than using the PRF output as the encryption key directly. Per Tim Cappalli (W3C WebAuthn L3 co-editor), passkey rotation invalidates PRF output — wrapping a DEK we control means re-enrolling with a new passkey can re-wrap the same DEK without re-encrypting the keys blob. Don't "simplify" this to PRF-output-as-key.
17. **PDF outline = pdfjs only; AI is the only fallback** (ADR-0008 / M10). pdfjs's `doc.getOutline()` hits ~40–60% of commercial fiction (author-declared `/Outlines` tree); for the rest, **there is no deterministic fallback** — the user must re-process via AI from the library. The pre-M10 heuristic detector (`lib/outline/detect.ts`) was **deleted entirely** because its keyword regex matched body prose (`"Part of the reason"`, `"Chapter 1 was the worst day"`) and its font-size signals were polluted by drop caps + running headers. **Do not reintroduce a regex/font-size heuristic** — it produces more wrong outlines than right ones on real fiction. If you need chapter splitting for a non-PDF format or an unstructured PDF, the answer is `useOutline.runWithAi`. **Tier 1 runs automatically on every PDF upload** (inside `pdf.ts:parse()`); the library's "Re-process outline" menu action is only for re-running after a parser change or reverting an AI override. Outline navigation accuracy depends on capturing the **Y coord** from the dest array (`[pageRef, left, top, zoom]`): `groupPagesIntoChapters` partitions the start page at `startY` so paragraphs above the heading stay in the previous chapter — without this, mid-page chapter starts bleed into the wrong chapter and the reader's outline navigation lands on a paragraph from the chapter before. A leading body paragraph that textually matches the chapter title is stripped (so the TTS doesn't read "Chapter 5" then "Chapter 5: The Discovery" back-to-back).
18. **Screen wake lock during upload is best-effort and never throws** (ADR-0009). `acquireUploadWakeLock()` always resolves to a `WakeLockHandle` — missing API, rejected promise, or hidden-document conditions degrade to a no-op handle whose `release()` is also a no-op. The lock is held in `parseInWorker` (parse phase) and `uploadManager.runJob` (synth + mobile encode), and released in their `finally`/cleanup paths. It auto-re-acquires on `visibilitychange → visible` and on `sentinel.onrelease` (some Android OEMs drop the sentinel under power-save without a visibility change); a `reacquiring` guard prevents thundering-herd concurrent re-requests. Safari < 16.4 has no Wake Lock API → silent fallback to the existing "stall when locked" behaviour. **Do not make `request()` failure fatal to the upload.** Companion safety net: `reconcileInterruptedUploads()` runs once in `main.tsx` **before** `createRoot().render()` (the ordering eliminates a race where a user opens `/reader/<stale-id>` for a book the sweep is about to delete). A book with `uploading === true` at boot means the previous session was interrupted — if `getBookAudio(id)` returns a record, clear the flag; otherwise cascade-delete the book (mirrors the fresh-upload failure contract in `manager.ts` — the user has no investment in a half-baked initial upload). Don't reintroduce a "prompt at boot" or "keep + retry button" alternative; ADR-0009 explicitly chose silent recovery as least-surprising.
19. **Worker error boundaries preserve DOMException identity.** The TTS and concat workers post `{ name, code, message }` on failure; the main-thread clients reconstruct a real `DOMException` when a name is present, and they reject all pending requests if the worker fires an `error`/`messageerror`. Never rely on `error.message` alone across the worker boundary — name/code are needed to distinguish quota/readable/OOM errors.
20. **Mobile whole-book encode has a hard cap.** Before `encodeBook`, the upload manager estimates the final m4a size from the accumulated paragraph durations (64 kbps AAC). If it exceeds `MAX_MOBILE_M4A_BYTES` (~200 MB ≈ 7h of speech), the encode is skipped, the book uploads successfully, and `usePlayer` falls back to the desktop per-paragraph engine on mobile. Lock-screen playback pauses between paragraphs for those books until M9 streaming removes the cap.
21. **Active upload jobs pin their book's audio-cache entries.** `setPinnedAudioCacheBookId` skips pinned records in `evictAudioCacheToBudget` and `evictAudioCacheFraction` so a long book's own paragraphs aren't evicted mid-synthesis. The pin is cleared in `manager.runJob`'s `finally`.

## How to resume (in a new session)

Open opencode in this repo and say, e.g.:

> "Continue with M1 — Upload & Read. Read `docs/ROADMAP.md` and `docs/prds/M0-foundation.md` for established patterns, then plan M1 following the spec-driven workflow. The Piper integration is M2, not M1."

The agent auto-loads this file + `.opencode/rules/tech.md`. For TTS work, also point it at [`docs/spikes/piper-wasm.md`](docs/spikes/piper-wasm.md) (M2 recommendations: pin ORT 1.18.0, mirror wasm locally, single-threaded default, Web Worker, pre-download model to OPFS). For M6 (AI transforms), point it at [`tasks/plan.md`](tasks/plan.md) (cloud OpenAI-compatible engine; the on-device WebLLM backend was removed — ADR-0005). For M6.1 (biometric key caching), point it at [`docs/adr/0007-biometric-key-caching.md`](docs/adr/0007-biometric-key-caching.md) + [`tasks/plan-m6.1-biometric-keys.md`](tasks/plan-m6.1-biometric-keys.md) (opt-in WebAuthn PRF tier on top of M6's in-memory default; ADR-0004's in-memory tier stays the default and fallback). For M9 (mobile streaming), point it at [`docs/prds/M9-mobile-streaming.md`](docs/prds/M9-mobile-streaming.md) + [`docs/adr/0006-mobile-mse-streaming.md`](docs/adr/0006-mobile-mse-streaming.md) (MSE on hidden `<video>`, FFmpeg WASM fMP4 encoding, per-paragraph streaming, desktop unchanged). For M10 (PDF structure extraction), point it at [`docs/prds/M10-pdf-structure.md`](docs/prds/M10-pdf-structure.md) + [`docs/adr/0008-pdf-structure-extraction.md`](docs/adr/0008-pdf-structure-extraction.md) (3-tier: pdfjs `getOutline` → `getStructTree` → fixed heuristics; library "Re-process outline" sheet with pdfjs/Auto-detect/AI options).

## Non-goals (launch scope)

Cloud TTS/sync/store, accounts, multi-user, native app stores, DRM circumvention. See `docs/VISION.md`.
