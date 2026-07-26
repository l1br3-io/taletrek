# ADR-0009: Upload wake lock + boot sweep for interrupted uploads

- **Status:** Accepted (revised 2026-07-19 — see "Revision" below)
- **Date:** 2026-07-18
- **Companion:** [`0006-mobile-mse-streaming.md`](./0006-mobile-mse-streaming.md) (iOS `<video>` pause on lock — accepted limitation), [`0007-biometric-key-caching.md`](./0007-biometric-key-caching.md) (different lifecycle concern), [`0010-playback-engine-architecture.md`](./0010-playback-engine-architecture.md) (paused-job machinery this revision builds on)

> ## Revision (2026-07-19)
>
> The original "no audio → cascade-delete" recovery rule is **struck**. Real
> usage showed that iOS tab eviction during a multi-minute synth was deleting
> books the user had real investment in (the original file, the parsed
> chapters, and the partial audio cache all vanished together). The
> pluggable-engine work (ADR-0010) shipped first-class pausable synthesis with
> `book.uploadJob`; this revision extends that same machinery to true
> interruptions (tab evictions, crashes, OOM) — not just explicit user pauses.
>
> **New contract:** interrupted books become **paused**, not deleted.
> `runJob` persists `book.uploadJob` from the very first tick (not only on
> explicit pause), so even a surprise eviction leaves a resumable spec in IDB.
> The M8 content-addressed audioCache entries survive (keyed by content hash;
> cascade-clear is keyed off `bookId`, which now stays). The library shows a
> Resume button + the last-attempted paragraph location. The
> "alternatives considered" item about deferring auto-resume is unchanged —
> resume is still **user-initiated**, not auto-restarted at boot.

## Context

The upload flow (`uploadManager.runJob`) drives three CPU-heavy phases through Web Workers: parse (`parseInWorker`), Piper TTS pre-synth (`preSynthesizeBook`), and — on mobile — FFmpeg WASM M4A encode (`concatClient`). A long book can take many minutes to process.

On mobile, the screen auto-locks on a fixed timer (typically 30s). When the screen locks:

- **iOS Safari** suspends the page within seconds. JS execution, the workers, and pending promises freeze. The async `runJob` chain doesn't *fail* — it stops making progress. If the OS evicts the tab under memory pressure (a real risk during heavy WASM TTS), the in-memory job is lost entirely.
- **Android Chrome** throttles similarly, eventually suspends.

Meanwhile the book record was written with `uploading: true` in `ingestBook` (`lib/ingest.ts:39`), before synth started. The flag is cleared only on clean completion by `clearUploadingFlag` (`lib/upload/manager.ts:65`). The initial-mode failure path (`manager.ts:424`) keeps the book on caught errors.

**Result (original contract):** if iOS evicts the tab mid-upload on a fresh book, the user saw a permanent "uploading…" badge on a book with no audio and no path to retry. **Result (revised contract):** the same book lands in the library as Paused with a Resume button.

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

**Browser support:** Chrome/Edge/Android, Safari 16.4+. Older Safari silently falls back to the no-op handle — the revised sweep picks up the slack. No hard dependency.

### 2. Boot sweep converts interrupted uploads to paused

`reconcileInterruptedUploads()` (`lib/upload/boot-sweep.ts`) runs once on app boot, **before** `createRoot().render()` in `main.tsx`. The ordering is critical — running the sweep before React mounts eliminates the race where a user opens `/reader/<stale-id>` directly and the Reader tries to load a book the sweep is about to transition.

**Recovery rule (revised 2026-07-19)** — for each book with `uploading === true`:

| Audio exists? | Action | Rationale |
| --- | --- | --- |
| Yes | Clear the flag, keep the book + audio | Synth actually finished but the flag wasn't cleared. Covers interrupted re-synths (mode `'resynth'`) where the user's old audio is still valid. |
| No | **Convert to paused** (`uploading = false`, leave the persisted `uploadJob`) | Initial-mode job was interrupted before any m4a landed. `runJob` persists `uploadJob` from the start (and bumps `done` per-¶) so the library can show Resume + accurate progress. The audioCache entries survive. **Legacy edge:** if `uploadJob` is missing (book started under pre-2026-07 code), clear `uploading` only and leave the book as a normal card; user hits "Synthesize" from the menu. |

Silent — logs to `console.info` with counts. Idempotent.

### 3. `runJob` persists `uploadJob` from the start (new in revision)

`uploadManager.runJob` writes `book.uploadJob = { voiceId, cleaning, mode, done: 0, total, pausedAt: now }` before the first paragraph synthesizes, then bumps `done` + `lastFlatIndex` + `lastChapterTitle` + `lastParagraphInChapter` + `lastChapterTotal` per-¶ via the new `preSynthesizeBook.onParagraphStart` callback. The book keeps `uploading: true` throughout so the sweep's "stuck" detection still triggers correctly.

On clean completion: `clearUploadJob` runs alongside `clearUploadingFlag`. On caught error (initial mode): both also run, so the library doesn't show Paused for an error-state book (the banner's Retry button is the path forward). On cancel: both run. On pause: `persistUploadJob` re-writes with the final `done` and sets `uploading = false`.

## Consequences

### Positive

- **Uploads complete reliably when the user puts the phone down.** Wake lock keeps the screen on; synth finishes; lock releases; normal auto-lock resumes. The most common cause of stuck "uploading…" badges is eliminated at the source.
- **Self-healing library — now with resume.** Even when the wake lock can't save the day (user manually locks, OS evicts tab, browser crashes, battery dies), the next app boot reconciles to a Paused state. The user's synthesized paragraphs survive in the M8 audioCache; resume fast-forwards.
- **No UX surface added for the happy path.** Wake lock is invisible; sweep is silent. A paused-after-eviction book does add a Resume button + progress badge, but only when the alternative would have been losing the book entirely.
- **Battery cost is opt-in to active jobs.** Wake lock is held only during parse + synth + encode, which is exactly when the user expects their phone to be doing work.

### Negative

- **Battery.** Holding the screen awake for a multi-minute synth is real battery cost. Accepted trade-off: the alternative is a broken upload. The user can always cancel via the GlobalUploadBanner.
- **iOS < 16.4 unaffected by wake lock.** ~3-year-old Safari versions silently fall back to the no-op handle. Revised sweep picks up the slack.
- **Sweep adds ~10ms to first paint** (a few IDB round-trips). Imperceptible.
- **Stuck books linger.** Pre-revision, interrupted initial uploads vanished silently. Post-revision, they sit in the library as Paused until the user explicitly resumes or deletes them. Accepted — strictly better than the alternative of losing the synth work; matches user intent.
- **Per-¶ IDB write.** `patchUploadJob` runs once per synthesized paragraph (~1ms each, ~1s spread across a 1000-¶ book). Negligible vs the ~50-500ms per Piper inference.

## Alternatives considered

- **Resume from M8 audio cache instead of restart.** The M8 content-addressed cache survives eviction, and `preSynthesizeBook` already skips cached paragraphs. The mechanic for resume exists — ADR-0010 made it first-class for explicit pauses; this revision extends it to true interruptions. Done.
- **Prompt the user at boot.** "X was interrupted, delete or retry?" Most explicit, most invasive — the user just opened the app and doesn't want to be asked. Silent recovery to a Paused state — visible in the library when they choose to look — is least surprising.
- **Keep the interrupted book + flag as error with a Retry button.** Pre-revision alternative. Rejected at the time because retrying an initial-mode upload would need the original file — but the original file was deleted along with the cascade. Post-revision the file is gone too (it always was, post-eviction), **but** the parsed chapters survive in IDB and the audioCache has the partial synth, so re-synthesizing from chapter 0 is cheap (cache hits fast-forward). The Resume button replaces Retry for the post-eviction case; Retry is still used for caught errors during the same session.
- **Wake lock scope including reader playback.** Playback has its own lifecycle handling (M3 Media Session, M9 mobile `<video>` engine, gotcha #13 about iOS lock-screen pause). Reader playback wake lock is a separate enhancement with its own tradeoffs; not in scope here.
- **Auto-resume-on-boot.** Still out of scope. The user opens the app for many reasons; auto-kicking off a multi-minute synth + wake lock is intrusive. Library badge → tap Resume → user-initiated.

## Cross-references

- **Gotcha #2** (ITP / Safari 7-day script storage) — the original uploaded file is the source of truth; the revised sweep preserves parsed chapters + audioCache so the user can re-synthesize without re-uploading.
- **Gotcha #13** (`<video>` elements pause on iOS lock screen) — the accepted limitation of M9 mobile streaming. The wake lock helps here too: as long as the wake lock is held, the screen doesn't lock in the first place. The two mechanisms are complementary, not redundant.
- **`uploadManager` failure contracts** (`manager.ts:424`) — the sweep's recovery rule mirrors the in-session failure contract: keep the book, surface as retryable.

## Test plan

Real-device verification required (jsdom can't reproduce tab suspension / OS eviction):

1. **Happy path with wake lock.** Upload a large book on a phone with auto-lock set to 30s. Set the phone down. Without the fix: screen locks → re-open → resume. With the fix: screen stays awake while the banner shows progress + current chapter/¶; lock releases when synth completes.
2. **Boot sweep, fresh upload interrupted (revised).** Start an upload, force-close the tab mid-synth. Reopen the app — the book should appear in the library as Paused with the chapter/¶ of the last attempt. Tap Resume — synth fast-forwards through cached paragraphs and continues.
3. **Boot sweep, resynth interrupted.** Re-synthesize an existing book; force-close mid-job. Reopen — the book should be present with old audio intact and no badge.
4. **Wake lock unsupported fallback.** On iOS < 16.4 (or by stubbing `navigator.wakeLock` to undefined in devtools), confirm upload still completes — no exception thrown.
