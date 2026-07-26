---
status: shipped
started: 2026-07-19
shipped: 2026-07-19
---

# SPEC — M11: Pluggable Playback Engines, Pausable Synthesis, Mobile Synth Lockdown

> **Status:** ✅ Shipped · 2026-07-19.
> Archived plan: [`plan.md`](./plan.md) · Checklist: [`todo.md`](./todo.md) ·
> Decisions: [`docs/adrs/0010-playback-engine-architecture.md`](../../../docs/adrs/0010-playback-engine-architecture.md) ·
> Spike gate: [`docs/spikes/web-audio-mobile.md`](../../../docs/spikes/web-audio-mobile.md).

## Problem

Today mobile playback depends on an FFmpeg WASM whole-book encode (M8.1): at upload time the concat worker downloads a ~30 MB core and produces a single m4a, then `usePreloadedPlayer` plays it through a hidden `<video>`. That path has real costs — the 30 MB download, an `encoding` phase that delays upload completion, duplicate storage (m4a alongside the WAV cache), a hard ~200 MB / ~7 h cap beyond which mobile silently falls back to the desktop per-paragraph engine (which is exactly the lock-broken path M9 exists to fix).

ADR-0006 rejected a Web Audio playback engine because "`AudioContext` suspends when tab hidden on iOS." But the chosen MSE approach accepts the same limitation: "`<video>` elements pause when the iOS screen locks; the user taps play to resume." Once we accept that parity, the Web Audio engine becomes viable — and it deletes the entire encode step, because the paragraph WAVs already sit in M8's content-addressed `audioCache`. We just play them on an `AudioContext`.

Two further gaps to close in the same milestone:

- **Synthesis can't be paused.** `uploadManager` supports abort-only cancel; the partial WAV cache is implicit checkpointing but nothing exposes resume to the user. Long books force the user to babysit the upload or lose it on the next app launch (ADR-0009's boot sweep cascade-deletes interrupted initial uploads).
- **Mobile reader is too clever during synthesis.** While a book is synthesizing, the mobile `usePlayer` silently falls back to the desktop per-paragraph engine — the exact engine that fails on lock — for whatever paragraphs happen to be cached. That's a trap, not a feature.

## Decisions (locked)

| Area | Decision |
| --- | --- |
| Web Audio engine role | **Playback only — no encode.** Paragraph WAVs already live in `audioCache`; `useWebAudioPlayer` decodes + schedules them on an `AudioContext`. The FFmpeg whole-book encode runs **only when the FFmpeg engine is resolved**. |
| Default engine | `'auto'` → **Web Audio (native)** when supported, else FFmpeg. Both engines are supported on virtually every modern browser, so the common case is Web Audio — no 30 MB download, no encode phase. |
| Engine selection | Capability detection + setting (`playbackEngine: 'auto' \| 'web-audio' \| 'ffmpeg'`). When both are supported the user can override in **Settings → Advanced** (default `'auto'` → Web Audio). Unsupported options render disabled with a "not supported on this device" hint. |
| Lock-screen behaviour | **Accepted parity with the FFmpeg engine.** `AudioContext` suspends on iOS lock (state `suspended` / `'interrupted'`); user taps play to resume from the suspended position. Same UX the MSE path already accepts (ADR-0006, gotcha #13). |
| Engine-switch residue | web-audio → ffmpeg on an already-uploaded book: m4a is absent → today's desktop fallback (gotcha #20) until the user re-synthesizes from the library (which now builds the m4a under the FFmpeg engine). ffmpeg → web-audio: a stale m4a may remain in `bookAudio` (accepted residue; per-book cascade clear handles eventual deletion). |
| Pause persistence | **Persisted on the book record, resumable after restart.** `book.uploadJob` carries `{ voiceId, cleaning, mode, done, total, pausedAt }`; `uploading = false` while paused. The boot sweep (ADR-0009) stays untouched — paused books are invisible to it. |
| Mobile synthesis lockdown | **Per-book, mobile-only.** While the open book has an active or paused synth job, `PlayerBar` is pinned in a synthesis mode (progress + Pause/Resume/Cancel) with playback disabled; desktop keeps play-during-synth; other books unaffected. |
| M9 fate | **Deferred indefinitely** (per ADR-0010). The whole-book m4a path stays as the FFmpeg-engine implementation. The `useStreamingPlayer` stub, `audioSegments` store, and `MSE_CODEC` constant stay dormant. Revisit only if real-world iOS Web Audio behaviour degrades. |

## Architecture

```
web/src/
  lib/
    playback/
      engines.ts          — PlaybackEngineId = 'web-audio' | 'ffmpeg'
                            PlaybackEngineSetting = 'auto' | PlaybackEngineId
                            MOBILE_ENGINES: capability registry
                            resolveMobileEngine(setting, caps?) → engineId
    audio/
      web-audio/
        scheduler.ts        — pure scheduling core (mock-AudioContext testable):
                              decode lookahead (2–3 ¶s), exact-time chaining via
                              start(when), seek/rate-change re-anchor, setInterval
                              advance loop (NEVER rAF — throttles when hidden)
        web-audio-controller.ts — AudioContext lifecycle: suspend()/resume()/stop(),
                              iOS 'interrupted' state handling via statechange
    upload/
      manager.ts            — JobState += 'paused'; pause()/resume(); encode gated
                              on resolved engine; persist book.uploadJob
  routes/
    reader/
      players/
        useParagraphAudioQueue.ts  — EXTRACTED from useDesktopPlayer: lookahead
                                     synth + cache-miss logic, shared by both
        useWebAudioPlayer.ts       — new; returns UseParagraphPlayerResult
        usePlayer.ts               — mobile branch switches on resolveMobileEngine()
        useDesktopPlayer.ts        — consumes the extracted queue (behaviour identical)
      ReaderPane.tsx               — mobile lockdown gating
      PlayerBar.tsx                — synthesis-mode render
    settings/
      SettingsPage.tsx             — new Advanced group (engine picker)
    library/
      useLibraryState.ts           — resume-paused-synthesis affordance
  components/
    GlobalUploadBanner.tsx         — Pause/Resume buttons
  context/settings.tsx             — playbackEngine key + migration
  types.ts                         — PersistedUploadJob on Book
```

### Engine resolution

```ts
// lib/playback/engines.ts
export type PlaybackEngineId = 'web-audio' | 'ffmpeg'
export type PlaybackEngineSetting = 'auto' | PlaybackEngineId

export interface EngineCapability {
  id: PlaybackEngineId
  label: string           // 'Web Audio (native)' / 'FFmpeg (compatibility)'
  supported(): boolean    // web-audio: typeof AudioContext !== 'undefined'
                          // ffmpeg: video.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '' && OPFS available
}

export const MOBILE_ENGINES: EngineCapability[] = [/* web-audio, ffmpeg */]

export function resolveMobileEngine(
  setting: PlaybackEngineSetting,
  caps: EngineCapability[] = MOBILE_ENGINES,
): PlaybackEngineId
// 'auto' → first supported in [web-audio, ffmpeg] preference order
// explicit → honored if supported; else the other engine + console.info
```

Two consumers of one resolution:

1. **Playback** (`usePlayer`): mobile branch picks `useWebAudioPlayer` (web-audio) or today's `getBookAudio` probe → `usePreloadedPlayer` (ffmpeg, with desktop fallback when no m4a — gotcha #20). Desktop branch untouched.
2. **Upload** (`manager.runJob`): the whole-book encode is gated on `isMobileDevice() && resolveMobileEngine(...) === 'ffmpeg'` (replaces bare `isMobileDevice()`). Web Audio users never download the 30 MB core, never see the `encoding` phase, never write a `bookAudio` record.

### Web Audio scheduler (the interesting core)

- `ctx = new AudioContext()` created on first play (user gesture satisfies autoplay policy).
- Pull WAVs via the shared `useParagraphAudioQueue` (reuses the desktop player's lookahead + on-demand re-synth on cache miss — the same robustness the desktop path already has).
- `decodeAudioData` with a 2–3 ¶ lookahead (decoded float32 ≈ 11 MB/min; bounded window keeps memory at a few MB).
- Chain via `source.start(scheduledEnd)` — **sample-accurate gapless, zero JS at paragraph boundaries**. This is what makes lock-suspend benign: nothing needs to run while locked; `ctx.currentTime` just freezes.
- Advance loop: `setInterval(~250 ms)` comparing `ctx.currentTime` against `paragraphOffsets` → binary-search → `currentParagraphId`. **Never rAF** (rAF throttles to ~1 Hz when hidden; timers throttle less aggressively and we keep ≥3 ¶s scheduled ahead regardless).
- Pause = `ctx.suspend()`; resume/play = `ctx.resume()`. Handle `'interrupted'` via `statechange` (treat as paused; tap-play calls `resume()`).
- Seek / rate change → **re-anchor**: stop future sources, reschedule from the target paragraph at `start(when, offset)`; update `source.playbackRate.value` on the new schedule.
- `getAudioPosition()` returns paragraph-relative `{ currentTime, duration }` for the existing `useMediaSession` (engine-agnostic already).

### Pause/resume

- New `JobState` variant `{ type: 'paused'; book; done; total; mode }`. `isActive()` unchanged — paused ≠ active, so another upload can run while one is paused.
- `pause()`: cooperative abort at the next paragraph boundary (existing `AbortController` mechanism), then persist `book.uploadJob = { voiceId, cleaning, mode, done, total, pausedAt }` and set `uploading = false`. **No DB version bump** — `uploadJob` is a new optional field on `Book`; IDB is schemaless for fields.
- `resume(bookId)`: load chapters from IDB, `startJob` with the persisted spec (persisted `voiceId`/`cleaning` ⇒ consistent audio set even if the user changed settings since), `uploading = true`, clear `uploadJob` on success. Cache hits fast-forward through already-synthesized paragraphs.
- Boot sweep (ADR-0009) unchanged — a paused book has `uploading = false` so it's invisible to the sweep. The sweep's cascade-delete still governs true interruptions (tab eviction, crash mid-synth).

### Mobile synthesis lockdown

In `ReaderPane` (already subscribes to `useUploadState`): coarse-pointer **and** this book's job is active or paused → `PlayerBar` renders synthesis mode: progress bar + status label + Pause/Resume/Cancel; playback buttons disabled; overflow menu reduced to non-playback items; the bar cannot be hidden or dismissed while the job lives. Desktop path unchanged. Other books unaffected.

## Non-goals (this milestone)

- **Audio-only MSE / HLS** — deferred with M9 (ADR-0010).
- **Desktop Web Audio engine** — desktop stays on `useDesktopPlayer` per the project's "desktop unchanged" convention. Web Audio could land on desktop later for true gapless; not now.
- **Auto-resume on boot** — ADR-0009's silent recovery stays for true interruptions; only explicit user pauses become resumable.
- **Resuming after a voice change** — the persisted spec pins the original `voiceId`; switching voices mid-paused-book is a re-synthesize, not a resume.
