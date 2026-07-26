# ADR-0010: Pluggable playback engines (Web Audio default, FFmpeg fallback)

- **Status:** Accepted
- **Date:** 2026-07-18
- **Companions:** [`0010`'s spike](../spikes/web-audio-mobile.md) (real-device gate), [`0006-mobile-mse-streaming.md`](./0006-mobile-mse-streaming.md) (supersedes its Web Audio rejection), [`0009-upload-wake-lock-and-boot-sweep.md`](./0009-upload-wake-lock-and-boot-sweep.md) (paused-job boundary)
- **Plan:** [`tasks/plan-m11-playback-engines.md`](../../tasks/plan-m11-playback-engines.md)

## Context

Mobile playback today depends on an FFmpeg WASM whole-book encode (M8.1): at upload time, the concat worker downloads a ~30 MB core and produces a single m4a, then `usePreloadedPlayer` plays it through a hidden `<video>`. That path works but carries real costs:

- **30 MB core download** on first mobile use (mitigated by OPFS caching, but still a real first-play friction + data cost).
- **An `encoding` phase** that delays upload completion and holds a wake lock longer.
- **Duplicate storage** — the m4a sits alongside the WAV cache that produced it.
- **A hard ~200 MB / ~7 h cap** (`MAX_MOBILE_M4A_BYTES`) beyond which the encode is silently skipped and mobile falls back to the desktop per-paragraph engine — which is exactly the lock-broken path M9 exists to fix.

Meanwhile, ADR-0006 rejected a Web Audio playback engine with a single line: *"`AudioContext` suspends when tab hidden on iOS. Not viable."* But the MSE `<video>` approach ADR-0006 chose accepts an equivalent limitation: *"`<video>` elements pause when the iOS screen locks; the user taps play to resume."* Once **lock-suspend → tap-resume** is the accepted UX, the rejection's premise no longer differentiates the two engines — both pause on lock, both resume via a tap.

Revisiting Web Audio is attractive because the paragraph WAVs **already** sit in M8's content-addressed `audioCache`. An `AudioContext` engine can decode and schedule those WAVs directly — deleting the entire encode step for the common case.

Two further problems are closed in the same milestone:

1. **Synthesis can't be paused.** `uploadManager` supports abort-only cancel; the partial WAV cache is implicit checkpointing but nothing exposes resume. Long books force the user to babysit the upload or lose it (ADR-0009's boot sweep cascade-deletes interrupted initial uploads).
2. **Mobile reader is too clever during synthesis.** While a book is synthesizing, `usePlayer` silently falls back to the desktop per-paragraph engine — the exact engine that fails on lock — for whatever paragraphs happen to be cached. That's a trap.

## Decision

### 1. Pluggable playback engine architecture — Web Audio default, FFmpeg fallback

Introduce an explicit engine layer with capability detection + a user setting:

```ts
type PlaybackEngineId = 'web-audio' | 'ffmpeg'
type PlaybackEngineSetting = 'auto' | PlaybackEngineId

// lib/playback/engines.ts
resolveMobileEngine(setting, caps?) → PlaybackEngineId
// 'auto' → web-audio if supported, else ffmpeg
// explicit → honored if supported, else the other engine + console.info
```

Two consumers of one resolution:

- **Playback** (`usePlayer`): mobile branch picks `useWebAudioPlayer` (web-audio) or today's `getBookAudio` probe → `usePreloadedPlayer` (ffmpeg, with desktop fallback when no m4a exists — gotcha #20).
- **Upload** (`manager.runJob`): the whole-book encode is gated on `isMobileDevice() && resolveMobileEngine(...) === 'ffmpeg'` (replaces bare `isMobileDevice()`).

**Default = `'auto'` → Web Audio (native)** when supported. Both engines are supported on virtually every modern browser, so the common case is Web Audio — no 30 MB download, no encode phase, no duplicate storage, no cap. When both are supported, the user can override in **Settings → Advanced**.

### 2. Web Audio engine = playback only; no encode

The Web Audio engine consumes paragraph WAVs from M8's content-addressed `audioCache` (cache misses re-synthesize on demand via the same path the desktop player already uses). It performs **no** FFmpeg work and writes **no** `bookAudio` record. The FFmpeg concat worker, the OPFS core cache, and the `bookAudio` store all remain — they power the FFmpeg engine, which is now the fallback rather than the default.

`useWebAudioPlayer` returns the existing `UseParagraphPlayerResult` interface, so every UI surface (`PlayerBar`, `useMediaSession`, highlighting, outline navigation) is engine-agnostic and unchanged.

### 3. Sample-accurate gapless scheduling; setInterval (never rAF) for the advance loop

- Paragraphs are decoded (`decodeAudioData`) on a 2–3 ¶ lookahead and chained via `source.start(scheduledEnd)` — **zero JS runs at paragraph boundaries.** This is what makes iOS lock-suspend benign: while locked, `ctx.currentTime` simply freezes; nothing needs to fire on schedule.
- The advance loop (which maps `ctx.currentTime` → `currentParagraphId` via binary search over offsets) runs on `setInterval(~250 ms)`, **not** `requestAnimationFrame`. rAF throttles to ~1 Hz when the tab is hidden; `setInterval` keeps the highlight tracking even when backgrounded, and ≥3 ¶s are scheduled ahead so a throttled tick never starves playback.
- Pause = `ctx.suspend()` (freezes `currentTime`). Resume/play = `ctx.resume()`. The `'interrupted'` state iOS uses is handled via `statechange` (treated as paused; a tap calls `resume()`). **Accepted parity with the MSE path's lock pause** (ADR-0006, gotcha #13).
- Seek / rate change → **re-anchor**: stop future sources, reschedule from the target paragraph at `start(when, offset)`, apply the new `playbackRate`. (Rate change mid-schedule would desync the offset table; re-anchoring keeps bookkeeping exact.)

### 4. Pausable synthesis, persisted across restart

- New `JobState` variant `{ type: 'paused'; book; done; total; mode }`. `pause()` is a cooperative abort at the next paragraph boundary (the existing `AbortController` mechanism — checked between paragraphs in `pre-synth.ts`), followed by persisting the job spec onto the book record and setting `uploading = false`.
- **Persisted spec:** `book.uploadJob = { voiceId, cleaning, mode, done, total, pausedAt }`. No DB version bump — it's a new optional field on `Book` (IDB is schemaless for fields; TS type change only). Persisted `voiceId`/`cleaning` guarantee the resumed audio set is consistent even if the user changed global settings since pausing.
- `resume(bookId)` reloads chapters from IDB and re-runs the same spec; cache hits fast-forward through already-synthesized paragraphs (the M8 cache already skips inference on hit), so resume is near-instant to the pause point.
- **ADR-0009 boundary unchanged.** A paused book has `uploading = false`, so it's invisible to `reconcileInterruptedUploads`. The sweep's cascade-delete still governs true interruptions (tab eviction, crash mid-synth). Explicit user pause is the only thing that becomes resumable; auto-resume-on-boot stays out of scope (ADR-0009's "alternatives considered" already deferred it).

### 5. Mobile synthesis lockdown

While the open book has an active or paused synth job **and** the device is coarse-pointer, `PlayerBar` is pinned in a synthesis mode: progress bar + status label + Pause/Resume/Cancel; playback controls disabled; overflow menu reduced to non-playback items; the bar cannot be hidden or dismissed until the job completes. **Desktop keeps play-during-synth; other books are unaffected.** This removes the silent-fallback-to-the-lock-broken-engine trap.

### 6. M9 deferred indefinitely

If the Phase-0 spike passes on real hardware, M9 (per-paragraph fMP4 + MSE streaming on a hidden `<video>`, ADR-0006) is **deferred indefinitely**. The whole-book m4a path stays as the FFmpeg-engine implementation. The `useStreamingPlayer` stub, the `audioSegments` IDB store, and the `MSE_CODEC` constant stay dormant in-tree. M9 is revisited only if real-world iOS Web Audio behaviour degrades — the pluggable architecture makes that a swap, not a rewrite.

## Consequences

### Positive

- **No 30 MB download, no encode phase, no duplicate storage, no cap** for the common (Web Audio) case. First mobile play is instant; uploads complete faster; mobile storage footprint shrinks.
- **Sample-accurate gapless playback** — strictly better than the desktop `<audio>` `ended`-chain (which has a small inter-¶ gap) and than the MSE append-timing approach.
- **Engine choice is reversible and user-controlled.** The `UseParagraphPlayerResult` contract + `resolveMobileEngine` make swapping engines a one-line selection change. If Web Audio misbehaves on a given device, the user picks FFmpeg in Advanced Settings and the next synthesis builds the m4a.
- **Pausable long-book synthesis.** Users no longer lose a multi-hour upload to a misclicked tab close or a needed phone restart.
- **Simpler mobile reader during synthesis** — one clear state (synth mode) instead of a silent fallback to the wrong engine.
- **M9's complexity is deferred** without losing the option. The dormant scaffolding stays available if needed.

### Negative

- **iOS tab-hidden-screen-on (jog mode) may pause.** If the spike confirms `AudioContext` suspends when the tab is hidden (screen still on), that's an honest regression vs the m4a `<video>` path (which keeps playing). Same tap-play applies; documented in ADR-0010 and the spike. Lock behaviour is identical (both pause); only the screen-on-background case differs.
- **Media Session / Now Playing likely absent on iOS lock screen** for AudioContext-only playback (no media element to claim the session). Unlock-and-tap is the accepted flow. A silent `<audio>`-element shim is the documented escape hatch if later deemed worth the complexity.
- **Engine switch leaves residue.** web-audio → ffmpeg on an already-uploaded book: m4a is absent → desktop fallback (gotcha #20) until re-synthesize. ffmpeg → web-audio: a stale m4a may remain in `bookAudio` (accepted; per-book cascade clear handles eventual deletion).
- **Two engines to maintain.** The Web Audio engine is new code; the FFmpeg engine stays for fallback. Mitigated by the shared `useParagraphAudioQueue` (extracted from `useDesktopPlayer`) so the lookahead/cache-miss logic is written once.
- **Real-device gate.** The spike (iPhone + Android) is a hard gate before Web Audio becomes default. If it fails, Web Audio ships opt-in only and M9 may be executed instead.

### New settings / schema

- `Settings.playbackEngine: 'auto' | 'web-audio' | 'ffmpeg'` (default `'auto'`); backfilled by `migrateSettings`.
- `Book.uploadJob?: PersistedUploadJob` — optional field, **no DB version bump** (IDB schemaless).

### Reversibility

The Web Audio engine is fully isolated behind `UseParagraphPlayerResult` and `resolveMobileEngine`. If iOS behaviour degrades in a future Safari release, flipping the default back to `'ffmpeg'` (or executing M9) is a one-line change with no UI, manager, or engine-contract impact.

## Alternatives considered

- **Execute M9 as written (MSE on `<video>` + FFmpeg fMP4 segments).** More moving parts (per-paragraph encode worker, fMP4 muxing, `SourceBuffer.appendBuffer` choreography, init-segment sharing) for the same accepted lock limitation. Costs the 30 MB core download either way. Chosen only if the Web Audio spike fails.
- **Keep the m4a encode as a fallback alongside Web Audio (build both).** Doubles upload time and storage for a safety net the engine-switch + re-synthesize already provides. Rejected — the FFmpeg engine produces the m4a on demand when the user selects it.
- **Auto-resume interrupted uploads on next boot.** ADR-0009 explicitly deferred this (UX of "X was interrupted, retry?" at boot is invasive). This ADR adds only **explicit user pause** as resumable; interruptions stay governed by the silent sweep.
- **Web Audio on desktop too.** Could give desktop true gapless (today's `<audio>` `ended`-chain has a small inter-¶ gap). Rejected for scope — the project's "desktop unchanged" convention holds; Web Audio desktop is a future enhancement.
- **Silent `<audio>` element to claim the iOS Now Playing session.** The escape hatch for consequence #2 (Media Session absence). Deferred — adds a parallel media element whose lifecycle must stay in sync with the `AudioContext`. Documented as available.
- **`OfflineAudioContext` for faster-than-realtime pre-render.** Web Audio can render offline faster than realtime, but the output would need encoding to be useful as a file — back to needing FFmpeg. The on-demand decode-and-schedule approach needs no encoding and no extra storage, which is the whole point.

## Cross-references

- **ADR-0006** — supersedes its Web Audio rejection rationale (lock-suspend parity accepted). M9 deferred per this ADR.
- **ADR-0009** — paused jobs (`uploading = false`) are deliberately invisible to the boot sweep; only true interruptions stay sweep-governed.
- **Gotcha #5** (real-iPhone not verifiable via MCP) — the spike's hardware checklist is the gate.
- **Gotcha #13** (`<video>` pauses on iOS lock) — same accepted limitation now extended to the Web Audio engine.
- **Gotcha #20** (mobile whole-book encode cap) — the fallback the Web Audio engine eliminates for the common case; the FFmpeg engine still honours it.

## Test plan

- **Unit (Vitest + fake-indexeddb):** `resolveMobileEngine` matrix (auto/explicit × supported/unsupported × device); scheduler (chaining, seek re-anchor, suspend/resume, rate change) with a mock `AudioContext`; settings migration backfills `playbackEngine`; manager pause → persist `book.uploadJob` → simulated reload → resume fast-forwards through cache; encode-gate matrix (engine × device × book size); **paused book survives a simulated reload** (the ADR-0009 boundary); lockdown render logic.
- **Regression:** all existing `useDesktopPlayer` / `usePreloadedPlayer` / manager / boot-sweep tests green unchanged.
- **Chrome DevTools MCP** at mobile viewport: engine picker renders with support badges; Web Audio playback gapless through a chapter; lockdown bar during synth; pause/resume across a reload.
- **Real-device gate (manual, before "shipped"):** the spike checklist at [`docs/spikes/web-audio-mobile.md`](../spikes/web-audio-mobile.md) — items #1, #3, #4 must pass on iPhone.
