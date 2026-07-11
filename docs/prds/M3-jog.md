# PRD: M3 — Jog Mode

> **Status:** Ready to implement.
> **Companions:** [`../../VISION.md`](../VISION.md), [`../../ROADMAP.md`](../ROADMAP.md), [`M0-foundation.md`](M0-foundation.md), [`M1-upload-read.md`](M1-upload-read.md), [`M2-speak.md`](M2-speak.md), [`../spikes/piper-wasm.md`](../spikes/piper-wasm.md), [`../adr/0002-mit-piper-pipeline.md`](../adr/0002-mit-piper-pipeline.md).

## Objective

Turn M2's foreground read-along into a hands-free background experience. Text chunks are **pre-rendered into audio buffers ahead of the current playback position**, then played through the same single `<audio>` element with the **Media Session API** configured for lock-screen controls. Because iOS and Android both guarantee background playback of audio media, the story keeps flowing when the screen locks, when you switch apps, and when the browser is backgrounded. Lock-screen controls — play, pause, skip forward/back — appear automatically. This is what makes TaleTrek usable for jogging, commuting, and any hands-free scenario.

**User story:** *As a reader, I start my book, lock my phone, and the audio keeps playing. The lock screen shows the book title and chapter, with controls to play, pause, and skip chapters. The next paragraph is always ready before the current one finishes — no gaps, no stuttering.*

This is **background/Jog mode** built on top of M2's inline read-along. It does **not** change the foreground read-along UX (highlight, tap-to-seek) — it adds a look-ahead pre-render queue, Media Session metadata + lock-screen handlers, and the audio-element/PWA attributes required for background continuity.

## Decisions (locked)

| Area                              | Decision                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-render strategy               | **Fixed N=3 paragraphs ahead** (constant, tunable). Current paragraph synthesizes and plays ASAP; look-ahead synth overlaps playback.  |
| Pre-render ordering               | Play-current-first, **never block** first play on a full prime. Look-ahead fills during playback (warm synth ≈1s ≪ audio duration).     |
| Pre-render storage                | In-memory `Map<paragraphId, Blob>` → Blob URLs created on consume. Revoked on advance/seek/unmount (extends M2's Blob-URL hygiene).     |
| Back-pressure                     | Cap the queue at N; do not synth beyond N ahead. If the pointer moves (seek/next/prev/chapter-skip), invalidate + revoke the queue and re-prime. |
| Lock-screen next/prev track       | **Skip by chapter** — jump to the first paragraph of the next/previous chapter.                                                          |
| Lock-screen seek fwd/back         | **±15 seconds** within the current paragraph's audio (clamped to the paragraph's start/end).                                             |
| Lock-screen seekto                | Scrub to an absolute position within the current paragraph (where supported by the browser).                                            |
| In-app PlayerBar next/prev        | **Unchanged — paragraph level** (no regression to M2's read-along UX). Chapter-skip surfaces via Media Session + optional T5 buttons.   |
| Media Session metadata            | `title` = book title · `artist` = author/"TaleTrek" · `album` = current chapter title · `artwork` = app icon (book cover is M5).        |
| Position state                    | `setPositionState` updated per paragraph (duration + position) where supported — drives the lock-screen seekbar on compatible browsers.   |
| Playback medium                   | Same single off-DOM `<audio>` + Blob URLs from M2. One media = continuous Media Session across paragraph advances.                        |
| Audio attributes                  | `playsinline` + `preload="auto"` on the audio element (iOS background-audio prerequisites).                                              |
| PWA attributes                    | iOS meta tags (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`) added to `index.html` (supplement the manifest). |
| Playback state ownership          | Stays in the `/reader` **container** (variant types) — **never Context** (per AGENTS.md convention).                                      |
| Position persistence              | **None in M3** — resumes at chapter start each session; reading-position memory remains M5's scope. **No DB schema bump.**                |
| Background-audio verification     | Desktop MCP verifies **tab-backgrounding** continuity + Media Session wiring. **Real-iPhone background playback is a manual gate** (gotcha #5), documented as a tracked risk — not a CI gate. |
| Licensing                         | ADR-0002 (MIT pipeline) unchanged; no new dependencies.                                                                                  |

## Technologies (additions to M0/M1/M2)

| Package | Version | License | Purpose |
| ------- | ------- | ------- | ------- |
| —       | —       | —       | **No new dependencies.** M3 uses only platform APIs already available: `HTMLMediaElement` (`playsinline`, `playbackRate`, `currentTime`, `duration`), `navigator.mediaSession` (`MediaMetadata`, `setActionHandler`, `playbackState`, `setPositionState`). |

No new dev dependencies either. M3 is a pure architecture/integration milestone on top of M2's Piper worker + playback hook. Adding dependencies is ask-first per M0 boundaries.

## Domain model (additions)

No new branded types. M3 reuses M2's `VoiceId`/`SynthesisRequest`/`SynthesisResult`/`TtsEngine` and `Chapter`/`ParagraphRef`. New structural types live next to the playback hook:

```ts
/** A pre-rendered audio chunk keyed by its paragraph id. */
interface RenderedChunk {
  paragraphId: string
  blob: Blob
  /** Lazily created on consume; revoked after playback or on invalidate. */
  url: string | null
}

/** Look-ahead pre-render queue config. */
interface PrerenderConfig {
  /** How many paragraphs to keep rendered ahead of the pointer. */
  lookahead: number // default 3
}

/** Media Session metadata derived from the loaded book + current chapter. */
interface MediaMetadataInput {
  title: string        // book title
  artist: string       // author, or 'TaleTrek'
  album: string        // current chapter title
  artworkUrl: string   // app icon URL (book cover is M5)
}

/** Injected Media Session handlers — the container binds these to the player. */
interface MediaSessionHandlers {
  play(): void
  pause(): void
  seekbackward(): void
  seekforward(): void
  seekto(detail: { seekTime?: number; fastSeek?: boolean | null }): void
  nexttrack(): void    // → nextChapter
  previoustrack(): void // → prevChapter
}
```

The `AudioController` boundary (M2) gains two methods so the queue + Media Session can drive it without a real `<audio>`:

```ts
interface AudioController {
  // …existing M2 methods…
  /** Seek to a relative offset (seconds) within the current media, clamped. */
  seekBy(deltaSeconds: number): void
  /** Seek to an absolute time (seconds) within the current media. */
  seekTo(seconds: number): void
  /** Current playback position within the current media, in seconds. */
  get currentTime(): number
  /** Duration of the current media, in seconds. */
  get duration(): number
}
```

## Architecture

```
                          ┌──────────────────────────────────────────┐
  SettingsProvider        │  voiceId, playbackRate  (low-frequency)  │
  (Context — settings)    │  persisted in IndexedDB `settings` store │
                          └──────────────────┬───────────────────────┘
                                             │ reads
  /reader container ─────────────────────────┼─────────────────────────
  (owns playback state — NEVER Context)      │
    useParagraphPlayer(book, chapters):      │
      pointer → ┌─ pre-render queue (N=3) ──┐ │
                │  Map<paraId, RenderedChunk│ │
                │  synth current + look-ahead│ ◄ engine.synthesize()
                └── advance from buffer ────┘
                         │  Blob URL on consume
                         ▼
       <audio playsinline>  ──► on 'ended' → advance from queue (gapless)
                              ──► seekBy/seekTo (Media Session)
                              ──► currentTime/duration → setPositionState
                                            ▼
  Media Session module (lib/media-session.ts):
    setMediaMetadata({ title, artist, album, artwork })
    setMediaSessionHandlers({ play, pause, seek±15s, seekto, next/prev → chapter })
    setPlaybackState('playing' | 'paused' | 'none')
    setPositionState({ duration, position, playbackRate })
                                            ▼
  OS lock-screen controls (iOS / Android):
    ▶/⏸  ·  ⏮/⏭ (chapter)  ·  ±15s  ·  seekbar  ·  title + chapter + artwork
```

- The `/reader` route remains the **container** (owns data + playback state). `ReaderView`, `PlayerBar` stay **presentational**. The Media Session module is pure (no React) — the container calls it in effects.
- The **pre-render queue lives inside `useParagraphPlayer`** — the hook owns the pointer, the queue, and Blob-URL lifecycle. The hook exposes new `nextChapter`/`prevChapter` and keeps the existing `play`/`pause`/`stop`/`next`/`prev`/`seekToParagraph`.
- Playback state stays a **variant type**; M3 adds a `'buffering'` nuance to `'loading'` (synthesizing the *current* vs. pre-rendering *ahead*) surfaced as a flag on the status, not a new variant.
- Media Session handlers are **registered once on mount** and **delegate to refs** so they always call the latest player functions without re-registering (avoids handler churn on every status change).

## Commands

Unchanged from M2 — run at the workspace root:

```
pnpm install              # install deps (no additions in M3)
pnpm dev                  # Vite dev server (web/)
pnpm build                # production build → web/dist
pnpm typecheck            # tsc --noEmit
pnpm lint                 | biome check (spike/ excluded)
pnpm lint:fix             # biome check --write
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build (run before commits)
```

## Project structure (additions under `web/src/`)

```
hooks/
  useParagraphPlayer.ts           + pre-render queue (Map<paraId, RenderedChunk>),
                                   lookahead=3, gapless advance, invalidate-on-seek,
                                   nextChapter()/prevChapter(), seekBy/seekTo passthrough
  useParagraphPlayer.test.ts      + queue fill/advance/invalidate/back-pressure tests
lib/
  media-session.ts                + setMediaMetadata, setMediaSessionHandlers,
                                   setPlaybackState, setPositionState (guarded, pure)
  media-session.test.ts           + metadata/handler/state wiring (mocked navigator.mediaSession)
components/
  PlayerBar.tsx                   + "buffering ahead" affordance + optional chapter-skip buttons
  PlayerBar.test.tsx              + extended states
routes/
  reader.tsx                      + Media Session effect (metadata on book/chapter change,
                                   handlers → player, playback/position state on transitions)
  reader.test.tsx                 + metadata reflects book/chapter, handlers invoke player
index.html                        + apple-mobile-web-app-capable + status-bar-style meta
```

## Code style

Follows `.opencode/tech/typescript/patterns.md` + `react/patterns.md` and the M0/M1/M2 conventions. Highlights:

- **Strict TS**, branded IDs, `import type` for type-only imports (`verbatimModuleSyntax`)
- **Container/presentational split** — `reader.tsx` owns data + playback state + Media Session wiring; `ReaderView` / `PlayerBar` are pure props
- **Context for low-frequency state only** (settings) — playback + Media Session live in the container, never Context
- **Variant types** for async/machine states; no new top-level variant for buffering (flag on `'loading'`)
- **Define the contract before implementing** — `MediaSessionHandlers` + extended `AudioController` before the concrete wiring
- **Media Session handler registration is idempotent** — register once per mount, delegate to refs; cleanup on unmount
- No comments unless asked; Biome handles format/import-order (2-space, single quotes, no semicolons, trailing commas)
- **Blob URL hygiene** — every pre-rendered Blob URL is revoked on consume (advance), invalidate (seek), and unmount (extends M2's invariant to the queue, not just the current URL)

## Testing strategy

- **`useParagraphPlayer`** (`hooks/useParagraphPlayer.test.ts`, extended): the existing `FakeAudio` + stub `TtsEngine` boundary is extended with `seekBy`/`seekTo`/`currentTime`/`duration`. New tests assert: (a) on `play`, the current paragraph is synthesized **first** and look-ahead synth fills the queue to N=3; (b) on `ended`, the next chunk plays from the buffer (no new synth for the immediately-next paragraph); (c) seek/next/prev/stop **invalidate** the queue (Blob URLs revoked); (d) `nextChapter`/`prevChapter` jump to the right paragraph; (e) back-pressure — synth is not requested beyond N ahead; (f) the `'buffering'` flag distinguishes current-synth from look-ahead.
- **Media Session module** (`lib/media-session.test.ts`): `navigator.mediaSession` + `MediaMetadata` are mocked (jsdom has neither). Assert `setMediaMetadata` constructs `MediaMetadata` with the right fields; `setMediaSessionHandlers` registers all seven actions and the returned cleanup removes them; `setPlaybackState`/`setPositionState` call through and **no-op gracefully** when unsupported.
- **Reader container** (`routes/reader.test.tsx`, extended): assert metadata reflects the loaded book + current chapter; a handler invocation calls the corresponding player method (via a spy on the hook result or an injected player boundary).
- **PlayerBar** (`components/PlayerBar.test.tsx`, extended): "buffering ahead" label renders; chapter-skip buttons (if added) call the right callbacks.
- **Browser** (chrome-devtools MCP): play through a chapter (gapless, queue pre-rendering), confirm `navigator.mediaSession.metadata` is set and all action handlers are registered, **background the tab** (`document.visibilityState` → `'hidden'`) and confirm audio keeps playing with zero console errors, zero cdnjs calls. **Real-iPhone background playback is NOT in scope for MCP** — it is a manual gate (see Risks).
- **Coverage target:** `hooks/useParagraphPlayer` + `lib/media-session` >80% (per M0).

## Boundaries

- **Always:** `pnpm typecheck && pnpm test && pnpm lint` green before considering a task done; define interfaces before implementing; revoke every Blob URL (current **and** queued); guard every Media Session call with `isMediaSessionSupported()`.
- **Ask first:** adding dependencies; changing the IndexedDB schema version; modifying the service-worker precache list or `vite-plugin-pwa` strategy; adding COOP/COEP headers (we stay single-threaded — do **not** add cross-origin isolation without sign-off, it breaks any-host static hosting).
- **Never:** commit secrets or large binary models; disable strict TS; depend on a CDN at runtime; put playback/Media Session state in Context; delete a failing test to make CI pass; claim iOS background playback "works" without a real-device run (gotcha #5).

## Success criteria (testable)

1. Start playback → audio plays gaplessly; the **next paragraph's audio is already rendered** by the time the current one ends (no synth stall between paragraphs).
2. The pre-render queue never holds more than N=3 chunks; a seek instantly invalidates and revokes the stale queue and re-primes around the new position.
3. `navigator.mediaSession.metadata` reflects the **book title**, **author/"TaleTrek"**, **current chapter title**, and **app artwork**; it updates when playback crosses a chapter boundary.
4. Lock-screen / OS media controls appear: play, pause, skip forward, skip back.
5. Lock-screen **next/prev track** jumps to the start of the **next/previous chapter**.
6. Lock-screen **seek forward/back** seeks **±15s** within the current paragraph (clamped).
7. `navigator.mediaSession.playbackState` tracks play/pause; `setPositionState` updates per paragraph on supported browsers.
8. **Tab-backgrounding** (desktop, via MCP): switching the tab to `visibilityState === 'hidden'` does **not** pause audio and produces **zero console errors**.
9. `pnpm verify` (lint + typecheck + test + build) is green.
10. chrome-devtools MCP run: **zero console errors**; **zero cdnjs network requests**; gapless pre-rendered playback through a chapter; Media Session metadata + handlers verified; tab-background continuity.

## Risks (tracked, not blocking)

| Risk | Mitigation |
| ---- | ---------- |
| **iOS Safari background playback unverified on real hardware (gotcha #5)** | M3 ships with desktop MCP verification (tab-backgrounding + Media Session wiring) and a **documented real-iPhone manual gate**. We add the known iOS prerequisites (`playsinline`, `apple-mobile-web-app-capable`, installed-to-home-screen standalone mode, Media Session active). A real-device run is required before publicly claiming background playback. |
| **Inter-paragraph micro-gap on `ended` → `loadAndPlay`** | Pre-rendering makes the next Blob URL ready before `ended`, so the handoff is sub-frame in practice. Measure in T6; if audible, revisit a concatenated-buffer approach (deferred — likely unnecessary). |
| **Single-threaded worker serializes pre-render synth** | Play-current-first: the first paragraph plays as soon as its synth resolves; look-ahead synth (warm ≈1s) runs during playback (paragraphs are many seconds). Cold-prime of N=3 is ≈6.5s if serialized, but we never block first play on the full prime. |
| **`MediaMetadata` / `setPositionState` support varies by browser** | Every Media Session call is guarded; absence degrades gracefully (controls still work where supported, no errors where not). Tests cover the no-op path. |
| **Pre-render Blob memory** | Queue is capped at N=3; consumed/stale Blobs are revoked immediately. A long book never accumulates more than N chunks in memory. |
| **Handler churn on status changes** | Handlers are registered once per mount and delegate to refs (always-current player fns) — no re-registration on every play/pause. |
| **Stale `ended` event (M2 deviation #4)** | The existing `playing`-status guard in `onEnded` is preserved; the queue's gapless advance respects it. |
| **Service worker caches stale M3 bundle** | Existing gotcha #3: test via `pnpm preview` + hard reload, or unregister the SW, when verifying source changes in-browser. |

## Tasks (ordered, dependency-chained)

| #   | Task | Acceptance | Verify | Files |
| --- | ---- | ---------- | ------ | ----- |
| T1  | Pre-render queue | `useParagraphPlayer` keeps N=3 paragraphs rendered ahead; plays current first; advances gaplessly from the buffer on `ended`; invalidates + revokes the queue on seek/next/prev/stop; adds `nextChapter`/`prevChapter`; `AudioController` extended with `seekBy`/`seekTo`/`currentTime`/`duration` | unit test (queue fill/advance/invalidate/back-pressure, chapter skip) | `hooks/useParagraphPlayer.ts`, `.test.ts` |
| T2  | Media Session module | `setMediaMetadata`/`setMediaSessionHandlers`/`setPlaybackState`/`setPositionState` implemented, all guarded by `isMediaSessionSupported()`; handler registration returns a cleanup | `lib/media-session.test.ts` (mocked `navigator.mediaSession`/`MediaMetadata`) | `lib/media-session.ts`, `.test.ts` |
| T3  | Wire Media Session into `/reader` | Metadata set on book/chapter change; handlers registered once on mount → delegate to player refs; playback/position state updated on transitions; cleanup on unmount | `routes/reader.test.tsx` (extended) | `routes/reader.tsx`, test |
| T4  | Background-audio readiness | Audio element has `playsinline` + `preload="auto"`; iOS meta tags in `index.html`; **tab-backgrounding** keeps audio playing with zero console errors (MCP) | chrome-devtools MCP (visibility → hidden) | `hooks/useParagraphPlayer.ts`, `index.html` |
| T5  | PlayerBar/UX | "Buffering ahead" state surfaced; chapter-skip buttons (mirror lock-screen chapter semantics) | `components/PlayerBar.test.tsx` (extended) | `components/PlayerBar.tsx`, `.test.tsx` |
| T6  | E2E + browser verify | Gapless through a chapter; Media Session metadata + handlers verified; tab-background continuity; zero console errors; zero cdnjs; `pnpm verify` green; real-iPhone checklist documented as a deviation/risk | full `pnpm verify` + chrome-devtools MCP | wiring + minor fixes |

**Ordering:** T1 → T2 → T3 → (T4 ∥ T5) → T6.

**Checkpoints:** A (T1: pre-render proven) · B (T2–T3: Media Session wired) · C (T4–T5: background-ready + UX) · D (T6: shipped, verify green).

## Out of scope (later milestones)

The configurable text-cleaning pipeline that strips links/images/footnotes/pronunciation dictionary (M4); the full library view, reading-position persistence (resume-where-you-left-off), cached-model management UI, book-cover artwork, and PWA polish (M5); adaptive (time-based) pre-render depth ( revisit if fixed-N shows gaps on real hardware); Media Session custom artwork per book (M5); Android-specific `MediaSession` platform integration beyond the standard web API.
