# Spike: Web Audio mobile playback engine

> **Status:** Desktop mechanics verified (2026-07-18). Real-iPhone + Android checklist pending — **required gate** before `useWebAudioPlayer` ships as the default mobile engine.
> **Track:** B (de-risking). Gates M11 / ADR-0010.
> **Companion:** [`../adr/0010-playback-engine-architecture.md`](../adr/0010-playback-engine-architecture.md), [`../adr/0006-mobile-mse-streaming.md`](../adr/0006-mobile-mse-streaming.md).

## Goal

Prove that an `AudioContext` can drive **gapless, paragraph-at-a-time playback** on iOS Safari and Chrome Android with the same accepted lock-screen limitation the MSE `<video>` path already ships under (ADR-0006, gotcha #13): the context suspends when the screen locks, and the user taps play to resume from the suspended position. If that parity holds, the entire FFmpeg whole-book encode (the 30 MB WASM core, the `encoding` phase, the duplicate m4a storage, the ~7 h cap) can be deleted for the common case — paragraph WAVs already live in M8's content-addressed `audioCache`, so Web Audio just decodes and schedules them.

## Why this isn't the same as ADR-0006's rejection

ADR-0006 rejected Web Audio with one line: *"AudioContext suspends when tab hidden on iOS. Not viable."* The MSE path it chose accepts an equivalent limitation: *"`<video>` elements pause when the iOS screen locks; user taps play to resume."* Once lock-suspend → tap-resume is the accepted UX, the rejection's premise no longer differentiates the two engines — **both** pause on lock, **both** resume via a tap. The spike exists to confirm the resume actually works reliably (no drift, no lost buffer, no stuck `interrupted` state), not to re-litigate the acceptability of a tap.

## Desktop results (Chrome 150, Linux — verified 2026-07-18)

Spike app at `spike/web-audio/` (`pnpm -C spike/web-audio dev`, port 5175). Procedural PCM "paragraphs" (distinct pitch per ¶ + a 30 ms click marker so boundaries are audible) scheduled gaplessly on a single `AudioContext`.

| Behaviour | Result |
| --- | --- |
| `AudioContext` created from a user gesture | ✅ `state=running` immediately on Play |
| Gapless chaining via `source.start(scheduledEnd)` | ✅ 8 × 6 s ¶s scheduled; advance loop tracks `¶0…¶7` with no gaps/overlaps |
| `ctx.suspend()` freezes `currentTime` | ✅ time held at 27.94 s across a 2 s wall-clock wait — the exact mechanism that makes iOS lock benign |
| `ctx.resume()` continues from frozen time | ✅ playback resumed mid-¶ from 27.94 s |
| Seek → stop-all + reschedule from target ¶ | ✅ seek to ¶6 re-anchored; new end = 46 s + 2 × 6 s = 58 s, math exact |
| `setInterval` advance loop (NOT rAF) | ✅ `currentParagraphId` updates ~10×/s |
| `MediaSession` handlers registered | ✅ (lock-screen card presence is the iOS checklist item, below) |
| Console errors | ✅ none (favicon 404 only) |

Desktop cannot reproduce iOS lock / tab-hidden behaviour. The following checklist **must** be run on real hardware before the Web Audio engine becomes the default.

## Real-device checklist (REQUIRED gate)

Deploy the spike somewhere with HTTPS (iOS requires it) — `pnpm -C spike/web-audio build && pnpm -C spike/web-audio preview`, or a Cloudflare tunnel. Open on a real device.

### iPhone (iOS Safari, latest)

- [ ] **1. Lock → resume.** Press **Play**. Mid-¶, press the hardware lock button. Note `ctx.state` (expected `suspended` or iOS-specific `interrupted`). Wait 5 s. Unlock. Tap **Resume**. **Audio continues mid-¶ from where it froze** (no restart, no skip). *This is the load-bearing assertion.*
- [ ] **2. Tab hidden, screen on (jog mode).** Press Play, then switch to another app (e.g. Mail) without locking. Note `visibility → hidden` in the log. Does audio keep playing? Does `currentTime` keep advancing? *(If it suspends here, that's an honest regression vs the m4a `<video>` path — document it; same tap-play applies. Affects the "listen while doing other things" use case with screen on, not the lock case.)*
- [ ] **3. Gapless through a lock.** Press Play, lock mid-¶0, unlock, resume — let it cross into ¶1. **No overlap, no gap, no pitch drift.** The `scheduledEnd` chaining must survive the suspend/resume intact.
- [ ] **4. Advance loop survives hidden.** With the tab hidden (screen on), reopen and confirm `idx` kept advancing — i.e. `setInterval` didn't starve. *(rAF would have; this is why the loop uses `setInterval` and keeps ≥2 ¶s scheduled ahead.)*
- [ ] **5. Media Session on the lock screen.** While playing, lock the phone. Is there a Now Playing card with controls? *(Expected: **absent** for AudioContext-only playback on iOS. The documented escape hatch is a silent `<audio>` element running alongside to claim the Now Playing session — out of scope for v1; unlock-and-tap is the accepted flow.)*
- [ ] **6. Multiple suspend/resume cycles.** Lock → unlock → resume → lock → unlock → resume, 5×. No stuck state, no leaked sources (memory in the Web Inspector stays bounded).

### Android (Chrome, latest)

- [ ] **7. Lock behaviour.** Same as #1. *(Expected: AudioContext keeps running under the screen-off lock on Chrome Android when a Media Session is active — potentially **better** than iOS. Verify and document.)*
- [ ] **8. Background tab.** Switch away from Chrome entirely. Does audio continue? *(Chrome Android generally allows background Web Audio with a media session.)*

## Go / no-go

- **Go** requires #1, #3, #4 to pass on iPhone. Those are the load-bearing behaviours; the whole architecture rests on "suspend freezes time, resume continues, scheduling survives."
- #2 and #5 are **documentation items, not blockers**. If #2 suspends, it's an accepted regression (jog-with-screen-on) noted in ADR-0010. If #5 is absent, unlock-and-tap is the accepted UX.
- **No-go** (resume is flaky, sources drift, `interrupted` gets stuck): keep the FFmpeg whole-book m4a as the default mobile engine, ship the Web Audio engine as an opt-in **Advanced** option only, and/or execute M9 as written. The pluggable engine architecture (T3–T6) still lands either way — it's the whole point of making this reversible.

## Reproducing

```
pnpm install
pnpm -C spike/web-audio dev        # http://localhost:5175
```

Press **(re)build buffers**, then **Play**. The event log shows every `statechange`, `visibilitychange`, `pagehide`, and Media Session invocation — correlating those timestamps with lock/unlock events is how the checklist above is filled in.
