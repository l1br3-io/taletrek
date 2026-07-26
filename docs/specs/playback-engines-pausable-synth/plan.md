# Plan: M11 — Pluggable Playback Engines, Pausable Synthesis, Mobile Synth Lockdown

> **Status:** ✅ Shipped · 2026-07-19 (archived).
> Spec: [`SPEC.md`](./SPEC.md) · Decisions: [`docs/adrs/0010-playback-engine-architecture.md`](../../../docs/adrs/0010-playback-engine-architecture.md) · Spike gate: [`docs/spikes/web-audio-mobile.md`](../../../docs/spikes/web-audio-mobile.md) · Checklist: [`todo.md`](./todo.md).

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

## Phase 0 — Spike (gate)

`docs/spikes/web-audio-mobile.md` + a throwaway spike page under `spike/web-audio/` (pattern after `spike/piper/`). Verify on a **real iPhone** and **Chrome Android** (gotcha #5: desktop MCP can't test lock):

1. iOS lock: `AudioContext.state` transitions (`suspended` / `'interrupted'`); `ctx.resume()` from a tap reliably continues mid-paragraph.
2. iOS tab-hidden-screen-on (jog mode — user in another app, screen on): does the context keep running? If it suspends, same accepted tap-play (documented).
3. Gapless: chain 3+ `AudioBufferSourceNode`s via `start(when)` through a lock/unlock cycle — no drift, no overlap, no advance-loop starvation.
4. Background advance: `setInterval`-driven scheduling keeps ≥1 ¶ buffered when the tab is hidden (rAF is throttled — confirmed constraint, not a risk).
5. Media Session / Now Playing without a media element on the iOS lock screen (expected absent → unlock-and-tap flow; document the silent-`<audio>`-element shim as an escape hatch).

**Go/no-go:** #1 + #3 + #4 must pass on iOS. #2 and #5 are documentation items, not blockers. If no-go: execute M9 as written; Phases 2–3 of this plan still apply.

## Phases

### Phase 1 — Engine architecture + Web Audio player
- `lib/playback/engines.ts` + settings key/migration + Advanced UI group
- ~~Extract `useParagraphAudioQueue` from `useDesktopPlayer`~~ **Descoped.** On reading `useDesktopPlayer`, its in-memory lookahead window is tightly coupled to the `<audio>` ended-chain; the real cache-miss abstraction already lives in `PiperEngine.synthesize` (checks `audioCache` internally). The project convention is self-contained player hooks (`useDesktopPlayer`/`usePreloadedPlayer`/`useStreamingPlayer`), so `useWebAudioPlayer` owns its own lookahead and calls `engine.synthesize({returnAudio: true})` directly — no shared hook, no desktop regression risk.
- `lib/audio/web-audio/scheduler.ts` + unit tests (pure class with a typed `AudioContextLike` interface; tests use a `FakeAudioContext` that records scheduled sources and simulates time advancement)
- `useWebAudioPlayer` returns `UseParagraphPlayerResult`
- `usePlayer` mobile branch switches on resolved engine
- `upload/manager.ts` encode gate switches to engine-aware

### Phase 2 — Pause/resume synthesis (orthogonal — can ship before Phase 1)
- `JobState` += `'paused'`; manager `pause()` / `resume(bookId)`
- `book.uploadJob` persistence (`types.ts`); no DB version bump
- `GlobalUploadBanner` Pause/Resume
- Library book-card "Synthesis paused · {done}/{total}" badge + Resume action

### Phase 3 — Mobile synthesis lockdown
- `ReaderPane` gating (mobile + this book's job active/paused)
- `PlayerBar` synthesis-mode render
- Overflow menu reduction during synth

### Docs
- **ADR-0010** — Web Audio engine + pluggable engine architecture. Supersedes ADR-0006's Web Audio rejection (lock-suspend parity accepted); records M9 deferral; engine-resolution contract; paused-job persistence vs ADR-0009's boundary.
- **AGENTS.md** — new gotchas (timer-not-rAF advance; `AudioContext` suspended/interrupted = pause, tap-play resumes; encode gated on resolved engine not device form-factor; paused jobs persist via `book.uploadJob` with `uploading=false` — don't "fix" the boot sweep). Status table: M11 added, M9 → deferred.
- **ROADMAP.md** — M11 entry; M9 marked deferred per ADR-0010.

## Tasks (ordered)

| # | Task | Acceptance | Verify | Files |
| --- | --- | --- | --- | --- |
| T1 | Web Audio spike page + real-device checklist | Spike runs on desktop; checklist documents the 5 behaviours above | manual on real iPhone + Android; desktop MCP smoke | `spike/web-audio/**`, `docs/spikes/web-audio-mobile.md` |
| T2 | ADR-0010 + ROADMAP + AGENTS status | ADR written; ROADMAP gets M11 + M9-deferred note; AGENTS status table updated | docs review | `docs/adrs/0010-*.md`, `docs/ROADMAP.md`, `AGENTS.md` |
| T3 | Engine registry + settings + Advanced UI | `resolveMobileEngine` matrix passes; settings key migrates; Advanced group renders with support badges | unit test (resolution matrix) + settings test | `lib/playback/engines.ts`, `context/settings.tsx`, `routes/settings/SettingsPage.tsx`, `*.test.ts(x)` |
| T4 | Extract `useParagraphAudioQueue` | Desktop player behaviour unchanged; queue module unit-tested | existing `useDesktopPlayer`/`useParagraphPlayer` tests green | `players/useParagraphAudioQueue.ts`, `useDesktopPlayer.ts` |
| T5 | Web Audio scheduler + controller | Chaining, seek re-anchor, suspend/resume, rate change — all unit-tested with mock `AudioContext` | unit test | `lib/audio/web-audio/scheduler.ts`, `web-audio-controller.ts`, `*.test.ts` |
| T6 | `useWebAudioPlayer` + `usePlayer` switch + encode gate | Web Audio plays gapless through a chapter on desktop MCP mobile viewport; manager skips encode when web-audio resolved | unit tests + MCP smoke | `players/useWebAudioPlayer.ts`, `players/usePlayer.ts`, `upload/manager.ts`, `*.test.ts(x)` |
| T7 | Manager pause/resume + persistence | pause → persist `book.uploadJob`; reload → resume fast-forwards through cache; boot sweep ignores paused books | unit test (fake-indexeddb round-trip) | `upload/manager.ts`, `types.ts`, `*.test.ts` |
| T8 | Banner + library resume UI | Banner shows Pause/Resume; library card shows paused badge + Resume | component tests | `GlobalUploadBanner.tsx`, `library/*` |
| T9 | ReaderPane + PlayerBar lockdown | Mobile + active/paused job → bar pinned in synth mode; desktop unchanged | component test + MCP | `ReaderPane.tsx`, `PlayerBar.tsx` |
| T10 | Verify | `pnpm verify` green; MCP mobile viewport pass; real-iPhone checklist documented | full `pnpm verify` + Chrome DevTools MCP | — |

**Ordering:** T1 → (gate) → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10. T7–T8 may run in parallel with T5–T6.

**Checkpoints:** A (T1 spike passes) · B (T3–T4 engine scaffolding) · C (T5–T6 Web Audio plays) · D (T7–T8 pausable) · E (T9 lockdown) · F (T10 ship).

## Risks (tracked)

| Risk | Impact | Mitigation |
| --- | --- | --- |
| iOS `AudioContext` resume-after-lock flaky | High — kills the Web Audio premise | Phase 0 spike gates everything. If flaky: keep FFmpeg engine as default, Web Audio opt-in only, or execute M9. |
| iOS tab-hidden (screen on) suspends `AudioContext` | Medium — jog-mode-with-screen-on pauses | Same accepted tap-play; document. The m4a path keeps playing here, so note the regression honestly in ADR-0010. |
| Media Session / Now Playing absent on iOS lock with AudioContext-only | Low — no lock-screen controls | Documented (unlock-and-tap). Silent-`<audio>`-element shim is a documented escape hatch if later deemed worth it. |
| Long-book memory via decoded lookahead | Low | 2–3 ¶ window ≈ few MB. Lookahead is bounded; cache misses re-synth on demand (no whole-book decode). |
| Engine switch leaves stale m4a | Low | Accepted residue; cascade clear handles eventual deletion. Document in ADR-0010. |
| Extracted queue breaks desktop player | Medium | T4 is a pure refactor with existing tests as the gate; no behaviour change. |
| Boot sweep interaction with paused jobs | High if wrong | Paused ⇒ `uploading = false` ⇒ invisible to sweep. Explicit unit test: paused book survives a simulated reload. |

## Testing & verification

- **Unit (Vitest + fake-indexeddb):** `resolveMobileEngine` matrix; scheduler (chaining, seek, suspend/resume, rate change) with mock `AudioContext`; settings migration; manager pause→persist→reload→resume round-trip; encode-gate matrix (engine × device); lockdown render logic; **paused book survives simulated reload**.
- **Regression:** all existing `useDesktopPlayer` / preloaded-player / manager / boot-sweep tests green unchanged.
- `pnpm verify` green.
- **Chrome DevTools MCP** at mobile viewport: engine picker renders with badges; Web Audio playback gapless through a chapter; lockdown bar during synth; pause/resume across a reload.
- **Manual gate (real iPhone):** spike checklist + lock/unlock tap-play resume. Required before any "shipped" claim (gotcha #5).

## Non-goals (this milestone)

- **Audio-only MSE / HLS** — deferred with M9 (ADR-0010).
- **Desktop Web Audio engine** — desktop stays on `useDesktopPlayer` per the project's "desktop unchanged" convention. Web Audio could land on desktop later for true gapless; not now.
- **Auto-resume on boot** — ADR-0009's silent recovery stays for true interruptions; only explicit user pauses become resumable.
- **Resuming after a voice change** — the persisted spec pins the original `voiceId`; switching voices mid-paused-book is a re-synthesize, not a resume.
