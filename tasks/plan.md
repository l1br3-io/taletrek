# M3 — Jog Mode · Plan

> Per-task detail for [`todo.md`](./todo.md). Spec: [`docs/prds/M3-jog.md`](../docs/prds/M3-jog.md).
> Ordering: T1 → T2 → T3 → (T4 ∥ T5) → T6.

## Resuming

**As of 2026-07-11 (M3 complete):** M3 — Jog Mode is **complete.**
`pnpm verify` green — lint ✅, typecheck ✅, test ✅ (**161 tests / 19 files**,
up from 120/17 in M2), build ✅ (97 modules, PWA generated). Browser-verified
via chrome-devtools MCP on the production preview build: uploaded a 3-"chapter"
TXT → Play → gapless playback through all paragraphs with the pre-render queue
synthesizing ahead (6 distinct blob URLs + repeated phonemize synth calls =
N=3 look-ahead confirmed), Media Session metadata wired (title=test-book,
artist=TaleTrek, album=chapter, artwork=app icon) + `playbackState` tracking
transitions (playing → none on natural end), chapter-skip buttons rendering,
all 4 iOS meta tags present, zero console errors (one benign ORT `numThreads`
warn — M2 deviation #2), zero cdnjs/jsdelivr calls.

**Working tree:** the M3 implementation is **uncommitted** — run
`git status --porcelain` for the live count. Land the work before starting M4.
Last commit: `16660a6 update M2`.

**Real-iPhone background-playback gate (gotcha #5) is still OPEN** — desktop MCP
verified Media Session wiring + tab-background continuity, but a locked-screen
run on real iOS hardware is required before claiming background playback works.
See "Real-iPhone manual gate" below for the checklist.

**Shipped this milestone:** look-ahead pre-render queue in `useParagraphPlayer`
(N=3, play-current-first, gapless advance from buffer, invalidate-on-seek,
voice-change buffer clear, back-pressure, `nextChapter`/`prevChapter`,
`seekBy`/`seekTo`/`getAudioPosition`); extended `AudioController` boundary
(`seekBy`/`seekTo`/`currentTime`/`duration`); `lib/media-session.ts` module
(`setMediaMetadata`/`setMediaSessionHandlers`/`setMediaPlaybackState`/
`setMediaPositionState`/`clearMediaSession`, all guarded); `useMediaSession`
hook (registers handlers once via refs, metadata on book/chapter change,
playback+position state on transitions); PlayerBar chapter-skip buttons +
buffering-ahead indicator; `playsinline` + iOS meta tags for background readiness.

---

## Tasks

### T1 — Pre-render queue in `useParagraphPlayer`
- **Detail:** Add a look-ahead buffer to the existing hook. Internally keep a
  `Map<paragraphId, RenderedChunk { blob, url }>` of pre-rendered audio. On
  `play`, synthesize the **current** paragraph first and play it as soon as it
  resolves (do NOT block on a full prime); concurrently kick off look-ahead
  synth for the next N=3 paragraphs (serialized through the worker, but
  overlapping with playback so warm ≈1s synth completes during the multi-second
  audio). On `ended`, advance the pointer and **play the already-buffered next
  chunk** (gapless), then top-up the queue by one. On any pointer move
  (`seekToParagraph`/`next`/`prev`/`stop`), **invalidate the queue**: revoke all
  queued Blob URLs and re-prime around the new position. Back-pressure: never
  synth beyond N ahead. Add `nextChapter()`/`prevChapter()` that jump the
  pointer to the first paragraph whose `chapterIndex` is ±1. Extend
  `AudioController` with `seekBy(delta)`/`seekTo(seconds)`/`currentTime`/
  `duration` getters (needed by T3 for Media Session seek + position state);
  the real impl wraps `HTMLAudioElement.currentTime`/`.duration`/`.pause()`+seek.
  Reuse the existing token-cancellation so stale look-ahead results are dropped.
  Keep the M2 `ended`-handler `playing`-status guard (deviation #4).
- **Depends on:** M2 (worker client + `useParagraphPlayer`).
- **Acceptance:** gapless advance from the buffer (no synth for the
  immediately-next paragraph on `ended`); queue invalidated + URLs revoked on
  seek; back-pressure honored (≤N synth calls outstanding); `nextChapter`/
  `prevChapter` land on the right paragraph; **every queued Blob URL is
  revoked** on consume/invalidate/unmount.
- **Verify:** `hooks/useParagraphPlayer.test.ts` (extended) — extend `FakeAudio`
  with the new boundary methods; assert queue fill/advance/invalidate/
  back-pressure + chapter skip.
- **Files:** `web/src/hooks/useParagraphPlayer.ts`, `useParagraphPlayer.test.ts`.

Checkpoint A — Pre-render proven (gapless playback through a chapter) · ☐

### T2 — Media Session module
- **Detail:** Extend `lib/media-session.ts` (currently a capability probe) with
  four pure, guarded functions: `setMediaMetadata({title, artist, album,
  artworkUrl})` → constructs `new MediaMetadata({...})` and assigns it;
  `setMediaSessionHandlers(handlers)` → registers all seven actions
  (`play`/`pause`/`seekbackward`/`seekforward`/`seekto`/`nexttrack`/
  `previoustrack`) and returns an unsubscribe that nulls them;
  `setPlaybackState('playing'|'paused'|'none')`; `setPositionState({duration,
  position, playbackRate})`. Every call no-ops gracefully when
  `!isMediaSessionSupported()` (the existing probe). No React, no DOM — pure
  platform-API wrappers.
- **Depends on:** — (foundation; T3 consumes it).
- **Acceptance:** all four functions call through correctly when supported and
  are no-ops when not; handler cleanup removes all seven handlers.
- **Verify:** `lib/media-session.test.ts` — mock `navigator.mediaSession` +
  `MediaMetadata` (jsdom has neither); assert metadata fields, handler
  registration + cleanup, playback/position state, and the unsupported no-op.
- **Files:** `web/src/lib/media-session.ts`, `media-session.test.ts`.

### T3 — Wire Media Session into `/reader`
- **Detail:** The container registers Media Session handlers **once on mount**
  (via `useEffect`) that delegate to **refs** holding the latest player
  functions — so handlers never go stale and we avoid re-registration churn on
  every status change. Handlers map: `play`→`player.play`, `pause`→`player.pause`,
  `seekbackward`→`player.seekBy(-15)`, `seekforward`→`player.seekBy(15)`,
  `seekto`→`player.seekTo`, `nexttrack`→`player.nextChapter`,
  `previoustrack`→`player.prevChapter`. A separate effect updates
  `setMediaMetadata` whenever the **book** or **current chapter** changes
  (derive chapter from `currentParagraphId` → `ParagraphRef.chapterIndex`).
  Update `setPlaybackState` + `setPositionState` on status transitions
  (`'playing'`/`'paused'`/`'ended'`/`'idle'`). Cleanup on unmount. Expose a thin
  injectable boundary so the reader test doesn't need a real `mediaSession`.
- **Depends on:** T1 (player chapter-skip + `seekBy`/`seekTo`/position), T2 (module).
- **Acceptance:** metadata reflects book title + current chapter; handlers
  invoke the correct player method; playback/position state tracks transitions;
  zero handler re-registration across re-renders.
- **Verify:** `routes/reader.test.tsx` (extended) — spy the media-session module
  or inject a fake; assert metadata + handler dispatch.
- **Files:** `web/src/routes/reader.tsx`, `reader.test.tsx`.

Checkpoint B — Media Session wired (metadata + lock-screen handlers active) · ☐

### T4 — Background-audio readiness
- **Detail:** Add `playsinline` + `preload="auto"` to the audio element in
  `createAudioController` (iOS background-audio prerequisites — without
  `playsinline`, iOS pauses on background). Add iOS meta tags to `index.html`:
  `apple-mobile-web-app-capable=yes` and `apple-mobile-web-app-status-bar-style`
  (the manifest's `display:standalone` handles Android; these supplement iOS).
  **Verify via MCP:** play a book, switch the tab to `visibilityState === 'hidden'`,
  confirm audio keeps playing with zero console errors. Document the
  **real-iPhone manual gate** (gotcha #5) as a tracked risk — desktop MCP cannot
  simulate a locked screen; a real-device run is required before claiming iOS
  background playback works.
- **Depends on:** T1–T3 (full playback + media session).
- **Acceptance:** `playsinline` + meta tags present; MCP tab-background run
  shows continuous audio + zero errors.
- **Verify:** chrome-devtools MCP — visibility change + console/network clean.
- **Files:** `web/src/hooks/useParagraphPlayer.ts`, `web/index.html`.

### T5 — PlayerBar/UX
- **Detail:** Surface a "buffering ahead" / "pre-rendering next…" affordance
  from the hook's look-ahead status (the `'buffering'` flag on `'loading'`,
  distinct from the cold-current synth state). Add **chapter-skip** buttons to
  `PlayerBar` so the in-app UX mirrors the lock-screen chapter semantics
  (existing next/prev stay paragraph-level; new ⏮⏭-style buttons jump chapters).
  `PlayerBar` stays **presentational** — new `onNextChapter`/`onPrevChapter` +
  a buffered-ahead indicator prop. Wire the new props in `reader.tsx`.
- **Depends on:** T1 (chapter skip + buffering flag). Parallel to T4.
- **Acceptance:** "buffering ahead" renders correctly; chapter-skip buttons
  call the right callbacks; PlayerBar remains props-only.
- **Verify:** `components/PlayerBar.test.tsx` (extended).
- **Files:** `web/src/components/PlayerBar.tsx`, `PlayerBar.test.tsx`, `routes/reader.tsx`.

Checkpoint C — Background-ready + UX complete · ☐

### T6 — End-to-end + browser verify
- **Detail:** Upload a book → play → gapless through a chapter with the queue
  pre-rendering ahead (no synth stall between paragraphs); seek mid-paragraph →
  queue invalidates + re-primes; skip chapter via lock-screen-equivalent →
  jumps to the chapter start; ±15s seek works; `navigator.mediaSession.metadata`
  reflects book + chapter; tab-backgrounding keeps audio playing; zero console
  errors; zero cdnjs calls; `pnpm verify` green. Write the real-iPhone
  verification checklist into the Deviations section below (and the PRD risks).
- **Depends on:** T1–T5 (full slice).
- **Acceptance:** `pnpm verify` green; chrome-devtools MCP run clean; iPhone
  gate documented.
- **Verify:** full `pnpm verify` green; MCP browser run.
- **Files:** wiring + minor fixes across the slice.

Checkpoint D — Jog slice shipped & `pnpm verify` green · ☐

---

## Deviations

1. **`useMediaSession` hook extracted (T3), not inlined in `reader.tsx`.** The
   PRD lists T3's wiring under `routes/reader.tsx`, but extracting the Media
   Session effects into a dedicated `hooks/useMediaSession.ts` made the wiring
   unit-testable with a stub player (mirrors the repo's hook-based style) and
   kept `ReaderPane` thin. The reader calls `useMediaSession({ player, ... })`;
   the hook owns handler registration (once, via refs), metadata updates, and
   playback/position state. No behavior change vs. the PRD; just a cleaner
   seam. Tests: `hooks/useMediaSession.test.ts` (13 tests).

2. **`upload_file` MCP tool can't seed the file input in `--isolated` mode.**
   The tool creates a filesystem-backed `File` whose handle the isolated
   browser profile can't re-read — `file.arrayBuffer()` rejects with
   `NotFoundError` ("A requested file or directory could not be found"). Not a
   code bug (the parse path is correct per gotcha #8); it's an environment
   limitation. T6's browser run worked around it by constructing an in-memory
   `File` via page-side JS and dispatching the `change` event. No production
   impact — real users drag/drop or pick via the native file picker, which
   yields a readable `File`.

## Real-iPhone manual gate (gotcha #5)

Desktop MCP cannot simulate a locked screen or true app-backgrounding on iOS.
Before M3 is considered "done" for the product's core promise, verify on a real
iPhone (installed to home screen, standalone mode):

1. Start playback → lock the screen → audio continues.
2. Lock-screen controls render (▶/⏸, ⏮/⏭ chapter skip, ±15s, seekbar).
3. Switch to another app → audio continues.
4. Background the browser fully → audio continues for ≥30s.
5. Re-open → playback state is intact.

If iOS fails any step, record the deviation here and adjust (e.g. a visible
`<audio>` element, a wake-lock, or scope the background claim to Android until
fixed). Do **not** publicly claim iOS background playback works without this run.
