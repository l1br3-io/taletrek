# ADR-0009: Upload wake lock + boot sweep for interrupted uploads

- **Status:** Accepted
- **Date:** 2026-07-18
- **Companion:** [`0006-mobile-mse-streaming.md`](./0006-mobile-mse-streaming.md) (iOS `<video>` pause on lock — accepted limitation), [`0007-biometric-key-caching.md`](./0007-biometric-key-caching.md) (different lifecycle concern)

## Context

The upload flow (`uploadManager.runJob`) drives three CPU-heavy phases through Web Workers: parse (`parseInWorker`), Piper TTS pre-synth (`preSynthesizeBook`), and — on mobile — FFmpeg WASM M4A encode (`concatClient`). A long book can take many minutes to process.

On mobile, the screen auto-locks on a fixed timer (typically 30s). When the screen locks:

- **iOS Safari** suspends the page within seconds. JS execution, the workers, and pending promises freeze. The async `runJob` chain doesn't *fail* — it stops making progress. If the OS evicts the tab under memory pressure (a real risk during heavy WASM TTS), the in-memory job is lost entirely.
- **Android Chrome** throttles similarly, eventually suspends.

Meanwhile the book record was written with `uploading: true` in `ingestBook` (`lib/ingest.ts:39`), before synth started. The flag is cleared only on clean completion by `clearUploadingFlag` (`lib/upload/manager.ts:65`). The initial-mode cascade-delete (`manager.ts:214`) only fires for **caught** errors — not for tab eviction or process termination.

**Result:** if iOS evicts the tab mid-upload on a fresh book, the user sees a permanent "uploading…" badge on a book with no audio and no path to retry.

## Decision

Two independent, complementary fixes:

### 1. Screen Wake Lock during upload + parse

`acquireUploadWakeLock()` (`lib/wake-lock.ts`) holds a `navigator.wakeLock.request('screen')` sentinel for the duration of the heavy work. Acquired in:

- `parseInWorker` (`lib/parse/client.ts`) — covers parse of large PDFs.
- `uploadManager.runJob` (`lib/upload/manager.ts`) — covers synth + mobile encode.

The lock keeps the screen awake, which keeps the page out of the throttled/suspended state where JS stops making progress. Released in the finally/cleanup paths so normal auto-lock resumes as soon as the work is done.

**Contract — the lock must never block real work:**

- `acquireUploadWakeLock` **always resolves** to a `WakeLockHandle`. Any failure (missing API, rejected promise, transient error) resolves to a no-op handle whose `release()` is also a no-op.
- The handle auto-re-acquires on `visibilitychange → visible` and on the sentinel's own `onrelease` event (some Android OEMs drop the sentinel under power-save without visibility change). A `reacquiring` guard prevents thundering-herd concurrent re-requests.
- A `deliberatelyReleased` flag prevents re-acquire loops after the caller's intentional `release()`.

**Browser support:** Chrome/Edge/Android, Safari 16.4+. Older Safari silently falls back to the no-op handle — the existing "stall when locked" behaviour is preserved on those devices. No hard dependency.

### 2. Boot sweep for interrupted uploads

`reconcileInterruptedUploads()` (`lib/upload/boot-sweep.ts`) runs once on app boot, **before** `createRoot().render()` in `main.tsx`. The ordering is critical — running the sweep before React mounts eliminates the race where a user opens `/reader/<stale-id>` directly and the Reader tries to load a book the sweep is about to delete.

**Recovery rule** — for each book with `uploading === true`:

| Audio exists? | Action | Rationale |
| --- | --- | --- |
| Yes | Clear the flag, keep the book + audio | Synth actually finished but the flag wasn't cleared. Covers interrupted re-synths (mode `'resynth'`) where the user's old audio is still valid. Matches the resynth failure contract in `manager.ts:213`. |
| No | Cascade-delete the book | Initial-mode job was interrupted before any audio landed. Matches the fresh-upload failure contract in `manager.ts:214` — the user has no investment in a half-baked upload. The original file goes with it, which is correct: the user hadn't successfully used it yet. |

Silent — logs to `console.info` with counts. Idempotent.

## Consequences

### Positive

- **Uploads complete reliably when the user puts the phone down.** Wake lock keeps the screen on; synth finishes; lock releases; normal auto-lock resumes. The most common cause of stuck "uploading…" badges is eliminated at the source.
- **Self-healing library.** Even when the wake lock can't save the day (user manually locks, OS evicts tab, browser crashes, battery dies), the next app boot reconciles to a clean state. No more permanent "uploading…" badge.
- **No UX surface added.** Wake lock is invisible; sweep is silent. No new toasts, dialogs, or settings.
- **Battery cost is opt-in to active jobs.** Wake lock is held only during parse + synth + encode, which is exactly when the user expects their phone to be doing work.

### Negative

- **Battery.** Holding the screen awake for a multi-minute synth is real battery cost. Accepted trade-off: the alternative is a broken upload. The user can always cancel via the GlobalUploadBanner.
- **iOS < 16.4 unaffected.** ~3-year-old Safari versions silently fall back to the no-op handle. Documented; not fixable without a native wrapper.
- **Sweep adds ~10ms to first paint** (a few IDB round-trips). Imperceptible; strictly better than the race it eliminates.

## Alternatives considered

- **Resume from M8 audio cache instead of restart.** The M8 content-addressed cache survives eviction, and `preSynthesizeBook` already skips cached paragraphs. The mechanic for resume exists — but designing the UX (auto-resume on next boot? user-initiated? what about voice-model changes mid-resume?) needs its own milestone. Wake lock + sweep is the right v1; resume is future work.
- **Prompt the user at boot.** "X was interrupted, delete or retry?" Most explicit, most invasive — the user just opened the app and doesn't want to be asked. Silent recovery matching the existing failure contracts is least surprising.
- **Keep the interrupted book + flag as error with a Retry button.** User must dismiss manually. For a fresh upload with no audio, retrying would need to re-parse the original file — but the original file is gone with the interrupted book. Re-upload is the same outcome with fewer clicks.
- **Wake lock scope including reader playback.** Playback has its own lifecycle handling (M3 Media Session, M9 mobile `<video>` engine, gotcha #13 about iOS lock-screen pause). Reader playback wake lock is a separate enhancement with its own tradeoffs; not in scope here.

## Cross-references

- **Gotcha #2** (ITP / Safari 7-day script storage) — the original uploaded file is the source of truth; the sweep's cascade-delete is consistent with that model (no master copy retained for interrupted initial uploads).
- **Gotcha #13** (`<video>` elements pause on iOS lock screen) — the accepted limitation of M9 mobile streaming. The wake lock helps here too: as long as the wake lock is held, the screen doesn't lock in the first place. The two mechanisms are complementary, not redundant.
- **`uploadManager` failure contracts** (`manager.ts:213-216`) — the sweep's recovery rule is a direct mirror of these contracts at boot time.

## Test plan

Real-device verification required (jsdom can't reproduce tab suspension / OS eviction):

1. **Happy path with wake lock.** Upload a large book on a phone with auto-lock set to 30s. Set the phone down. Without the fix: screen locks → re-open → resume. With the fix: screen stays awake while the banner shows progress; lock releases when synth completes.
2. **Boot sweep, fresh upload interrupted.** Start an upload, force-close the tab mid-synth. Reopen the app — the book should be gone (no audio had landed). No stuck "uploading…" badge.
3. **Boot sweep, resynth interrupted.** Re-synthesize an existing book; force-close mid-job. Reopen — the book should be present with old audio intact and no badge.
4. **Wake lock unsupported fallback.** On iOS < 16.4 (or by stubbing `navigator.wakeLock` to undefined in devtools), confirm upload still completes — no exception thrown.
