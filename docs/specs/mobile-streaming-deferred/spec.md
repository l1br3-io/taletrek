---
status: abandoned
started: 2026-07-16
---

# PRD: M9 — Mobile Streaming Playback

> **Abandoned** — deferred per [ADR-0010](../../adrs/0010-playback-engine-architecture.md); superseded for the common case by M11 ([`docs/specs/playback-engines-pausable-synth/`](../playback-engines-pausable-synth/spec.md)). Dormant scaffolding retained as the fallback path.

> **Companions:** [`../../VISION.md`](../../VISION.md), [`../../ROADMAP.md`](../../ROADMAP.md), [`../jog-mode/spec.md`](../jog-mode/spec.md), [`../audio-cache/spec.md`](../audio-cache/spec.md), [`../../adrs/0006-mobile-mse-streaming.md`](../../adrs/0006-mobile-mse-streaming.md).

## Objective

Fix mobile playback by adding a **separate streaming engine** that uses MediaSource Extensions (MSE) on a hidden `<video>` element, fed progressively via FFmpeg WASM-encoded fragmented MP4 (fMP4) segments. Desktop playback is **completely unchanged**.

**The problem:** M3's per-paragraph playback fails on iOS Safari with a locked screen. Each paragraph is a separate `<audio>` `src`. iOS allows the current media item to finish through a lock but blocks JavaScript from starting a new source (`src = newUrl; play()`) without a user gesture. The `ended → next paragraph` chain (`useParagraphPlayer.ts:463`) cannot proceed — current paragraph finishes, then silence.

**The solution:** On mobile, encode each paragraph's PCM WAV to a small fMP4 segment (AAC audio + 1x1 black H.264 video) via FFmpeg WASM, cache in IDB, then feed segments progressively to a single `MediaSource` on a hidden `<video>` element. One `src` (the `MediaSource` URL), set once — no track transitions during playback. MSE's `SourceBuffer.appendBuffer()` queues data for the media pipeline without requiring a user gesture.

**Accepted limitation:** `<video>` elements pause when the iOS screen locks. The user taps play when they return. The current paragraph resumes from its position. This is a deliberate trade-off — the alternative (per-paragraph `<audio>` on lock) fails entirely.

**User story:** *As a mobile reader, I press play and the audio streams continuously — paragraph after paragraph, gapless, with word-by-word highlighting tracking my position. I can seek, skip paragraphs, and jump chapters just like on desktop. If I lock my phone, playback pauses; when I unlock and tap play, it picks up right where I left off.*

## Decisions (locked)

| Area | Decision |
| --- | --- |
| Mobile playback engine | **MSE** (`MediaSource` + `SourceBuffer`) on a hidden `<video>` element. Progressive segment feeding via `appendBuffer`. |
| Desktop playback engine | **Unchanged.** `useParagraphPlayer` + per-paragraph `<audio>` + `ended → loadAndPlay`. Zero modifications. |
| Mode detection | `matchMedia('(pointer: coarse)')` → mobile. Settings override planned but not in v1. |
| Encoding library | **FFmpeg WASM** (`@ffmpeg/ffmpeg` latest, single-threaded `@ffmpeg/core`). MIT licensed. |
| FFmpeg core hosting | **OPFS download** on first mobile playback (~30MB). Cached for offline. Progress indicator. Like Piper voice models. |
| Single-threaded core | Avoids `SharedArrayBuffer` / COOP/COEP requirement. Encoding short speech clips is fast enough. |
| Encoding timing | **Synthesis-time** (background). Each paragraph encoded immediately after Piper synth. Cached in IDB. Playback reads from cache → instant. |
| Audio codec | **AAC 64kbps mono** (speech-optimized). Noted for future quality/size tuning. |
| Video track | **Always include** 1x1 black H.264 frame at 1fps. No audio-only experiment. `<video>` hidden regardless. Future optimization: drop video track if audio-only MSE proven on iOS. |
| Segment granularity | **Per-paragraph.** Each paragraph = one fMP4 segment. Clean highlight mapping via time offsets. |
| Init segment | One shared init segment per voice config (same sample rate, channels, codec). Generated once, reused. |
| Timestamp management | `SourceBuffer.timestampOffset` set before each `appendBuffer`. Read cumulative duration from `sourceBuffer.buffered.end()` after each append. |
| Player interface | `useStreamingPlayer` returns `UseParagraphPlayerResult` — **identical API** to `useParagraphPlayer`. Zero UI changes. |
| Cache storage | New IDB store `audioSegments` (DB v4). Keyed identically to M8's `audioCache` (`voiceId:NORM_VERSION:sha256(normalizedText)`). Stores fMP4 blobs. M8 WAV cache untouched. |
| `DB_VERSION` | **Bump 3 → 4.** Additive store only; no migration of existing records. |
| Worker architecture | Separate **encode worker** (`encode-worker.ts`). Receives WAV from main thread, runs FFmpeg WASM, returns fMP4. TTS worker stays separate. |
| Lock-screen behavior | **Accepted limitation:** `<video>` pauses on iOS lock. User taps play to resume. No workaround. |
| Migration | **None.** New cache populated on demand. Existing M8 WAV cache untouched. |
| Highlighting | `timeupdate` event (fires ~4x/sec) → binary search precomputed paragraph time offsets → `currentParagraphId`. |
| Navigation | `seekToParagraph(id)` → `video.currentTime = offset[id]`. `next`/`prev` → adjacent offset. `nextChapter`/`prevChapter` → first paragraph of target chapter. All within the single `<video>` timeline. |
| Licensing | New dep: `@ffmpeg/ffmpeg` (MIT). ADR-0002 (MIT pipeline) still in force. |

## Technologies (additions to M0–M8)

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `@ffmpeg/ffmpeg` | latest (0.12.x) | MIT | FFmpeg WASM wrapper — loads core, encodes WAV → fMP4 |
| `@ffmpeg/core` | latest (0.12.x) | MIT | FFmpeg WASM core (~30MB, downloaded to OPFS, not bundled) |
| `@ffmpeg/util` | latest (0.12.x) | MIT | Utility helpers (fetchWasm, etc.) |

No other new dependencies. MSE, MediaSource, SourceBuffer, and OPFS are platform APIs.

## Domain model (additions)

### DB schema (v4)

New store `audioSegments` alongside M8's `audioCache`:

```ts
/** DB v4: adds audioSegments store for mobile streaming. */
const DB_VERSION = 4

interface AudioSegmentRecord {
  /** Same key scheme as M8: `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}` */
  key: string
  /** The fMP4 blob (AAC audio + 1x1 black H.264 video). */
  blob: Blob
  /** Paragraph audio duration in seconds (for time-offset table). */
  duration: number
  /** For per-book cascade clear. */
  bookId?: BookId
  /** For LRU eviction. */
  lastUsed: number
}
```

Index: `byBookId` (for cascade clear), `byLastUsed` (for LRU eviction). Same pattern as M8.

### Encode worker protocol

```ts
/** Main thread → encode worker */
type EncodeRequest = {
  id: number
  type: 'encode'
  wav: ArrayBuffer  // PCM WAV bytes
}

/** Encode worker → main thread */
type EncodeResponse =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'success'; fmp4: ArrayBuffer; duration: number }
  | { id: number; type: 'error'; message: string }
```

### MSE controller interface

```ts
interface MseController {
  /** Initialize MediaSource on the given <video> element. Resolves on sourceopen. */
  init(video: HTMLVideoElement, codec: string): Promise<void>
  /** Append the init segment (moov box). Call once after init. */
  appendInit(data: ArrayBuffer): Promise<void>
  /** Append a media segment at the current cumulative offset. Resolves on updateend. */
  appendSegment(data: ArrayBuffer): Promise<{ bufferedEnd: number }>
  /** Set the timestamp offset for the next append. */
  setTimestampOffset(seconds: number): void
  /** Seek to an absolute time within the buffered range. */
  seekTo(seconds: number): void
  /** Register a timeupdate callback. */
  onTimeUpdate(cb: (currentTime: number) => void): () => void
  /** Current playback time. */
  readonly currentTime: number
  /** Total buffered duration. */
  readonly bufferedEnd: number
  /** Tear down: revoke URL, clear SourceBuffer, close MediaSource. */
  destroy(): void
}
```

### FFmpeg wrapper interface

```ts
interface FfmpegWrapper {
  /** Load FFmpeg core from OPFS (download from CDN on first use). */
  load(onProgress?: (fraction: number) => void): Promise<void>
  /** Whether the core is loaded and ready. */
  readonly loaded: boolean
  /**
   * Encode a PCM WAV blob to a fragmented MP4 (AAC audio + 1x1 black H.264 video).
   * Returns the fMP4 bytes and the audio duration in seconds.
   */
  encodeWavToFmp4(wav: Blob): Promise<{ fmp4: ArrayBuffer; duration: number }>
}
```

## Architecture

```
SYNTHESIS PIPELINE (background, per paragraph)
═══════════════════════════════════════════════

  Text ──→ Piper TTS Worker ──→ PCM WAV blob
                                  │
                                  ▼
                        Encode Worker (FFmpeg WASM)
                        ffmpeg -i para.wav \
                          -f lavfi -i color=c=black:s=1x1:r=1 \
                          -c:a aac -b:a 64k \
                          -c:v libx264 -pix_fmt yuv420p \
                          -shortest \
                          -f mp4 \
                          -movflags +frag_keyframe+empty_moov+default_base_moof \
                          para.mp4
                                  │
                                  ▼
                        IDB audioSegments store
                        (key: voiceId:normVer:sha256(normText))


PLAYBACK PIPELINE (mobile mode)
═══════════════════════════════

  User taps Play
       │
       ▼
  Read fMP4 segments from IDB (cache-first)
       │
       ▼
  MediaSource → hidden <video>.src = MS URL (set once)
       │
       ▼ (sourceopen)
  addSourceBuffer('video/mp4; codecs="avc1.42c01e,mp4a.40.2"')
       │
       ├── appendBuffer(initSegment)
       ├── timestampOffset = 0;  appendBuffer(seg_0)  → video.play()
       ├── timestampOffset = T1; appendBuffer(seg_1)  (before buffer runs low)
       ├── timestampOffset = T2; appendBuffer(seg_2)
       └── ... continuous, gapless
       │
       ▼ (timeupdate, ~4x/sec)
  binarySearch(offsets[], currentTime) → currentParagraphId → highlight


DESKTOP (unchanged)
═══════════════════
  useParagraphPlayer → per-paragraph <audio> → ended → next paragraph

MODE SELECTION
══════════════
  ReaderPane.tsx
    if (matchMedia('(pointer: coarse)').matches)
      useStreamingPlayer(...)    ← M9 new
    else
      useParagraphPlayer(...)    ← M3 current
    └── both return UseParagraphPlayerResult → zero UI changes
```

### FFmpeg core loading (OPFS, offline-first)

1. On first mobile playback, check if `@ffmpeg/core` WASM is in OPFS.
2. If not: download `ffmpeg-core.js` + `ffmpeg-core.wasm` (~30MB) from CDN to OPFS. Show progress indicator ("Loading audio engine…").
3. Load from OPFS via blob URLs: `ffmpeg.load({ coreURL, wasmURL })`.
4. On subsequent uses: load directly from OPFS. Works offline.

Pattern matches Piper voice model download flow (M2/M5).

### Segment feeding strategy

```
appendBuffer is async (queued by the browser).
No overlapping appends allowed — wait for updateend before next.

Algorithm:
  1. Append init segment → wait for updateend
  2. Append segment[0] at timestampOffset=0 → wait for updateend
  3. video.play()
  4. Monitor: while playing,
     a. Check buffered range ahead of currentTime
     b. If buffered-ahead < threshold (~10s):
        i.  Read next segment from IDB (or synthesize+encode on-the-fly if not cached)
        ii. Set timestampOffset = bufferedEnd
        iii. appendBuffer(segment) → wait for updateend
     c. Repeat
  5. On timeupdate: binarySearch offsets → highlight paragraph
```

### Time offset computation

Each paragraph's audio duration is known at encode time (WAV data size / byte rate). The offset table is built incrementally as segments are appended:

```ts
offsets[0] = 0
offsets[i] = offsets[i-1] + durations[i-1]
```

`timeupdate` handler uses binary search to find the paragraph whose `[offsets[i], offsets[i+1])` range contains `currentTime`.

## FFmpeg WASM specifics

| Concern | Detail |
| --- | --- |
| Package | `@ffmpeg/ffmpeg` (latest 0.12.x) — promise-based API, worker-native |
| Core | `@ffmpeg/core` (single-threaded) — ~30MB, downloaded to OPFS, not bundled |
| Threading | Single-threaded. Avoids `SharedArrayBuffer` / COOP/COEP. |
| Worker | Dedicated encode worker (`encode-worker.ts`). Receives `{wav: ArrayBuffer}`, returns `{fmp4: ArrayBuffer, duration: number}`. |
| FFmpeg flags | `-c:a aac -b:a 64k -c:v libx264 -pix_fmt yuv420p -shortest -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof` |
| Codec string (MSE) | `video/mp4; codecs="avc1.42c01e,mp4a.40.2"` (H.264 Baseline + AAC-LC) |
| Init segment | Generated once per voice config. Shared across all paragraphs with same audio parameters. |
| Verification needed | (a) `@ffmpeg/core` includes `libx264` + `aac` encoder. (b) fMP4 output is valid for MSE. Both verified in T2 spike. |

## Success criteria (testable)

1. **Mode detection**: opening the reader on a touch device (`pointer: coarse`) activates `useStreamingPlayer`; on a precision-pointer device, `useParagraphPlayer` is used. No console errors in either mode.
2. **Gapless playback**: pressing play starts audio immediately (from cached segment). Audio flows paragraph-to-paragraph with no audible gap, stutter, or silence.
3. **Paragraph highlighting**: `timeupdate` drives `currentParagraphId`. The highlighted paragraph tracks the audio position accurately (within ~250ms).
4. **Navigation parity**: `seekToParagraph`, `next`/`prev`, `nextChapter`/`prevChapter`, `navigateToParagraph`, `seekBy`, `seekTo` all work within the `<video>` timeline.
5. **Encoding**: a PCM WAV is encoded to a valid fMP4 with AAC + H.264. The segment is cached in IDB `audioSegments` store. Re-listen reads from cache (no re-encode).
6. **FFmpeg core loading**: first mobile play downloads the core to OPFS with a progress indicator. Subsequent plays load from OPFS (offline). No network calls after first download.
7. **Media Session**: metadata, playback state, and position state reflect the streaming player. Lock-screen controls (play/pause, chapter skip) work.
8. **Desktop regression**: all existing `useParagraphPlayer` tests pass unchanged. Desktop playback behaves exactly as before.
9. `pnpm verify` (lint + typecheck + test + build) is green.
10. Chrome DevTools MCP at mobile viewport: zero console errors, gapless streaming through a chapter, highlighting tracks correctly, seek works, Media Session wired.

## Risks (tracked, not blocking)

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **`@ffmpeg/core` doesn't include `libx264`** | Medium — blocks video track | Verify in T2 spike. If missing, use custom WASM build or switch video codec to `mjpeg` (simpler, universally included). |
| **MSE SourceBuffer rejects fMP4 segments** | Medium — format validation | Use verified FFmpeg flags. Test with Chrome first (lenient parser), then Safari. |
| **FFmpeg WASM ~30MB load time on mobile** | Medium — slow first play | Lazy-load with progress indicator. OPFS-cached after first download. Consider pre-loading during book upload/open. |
| **`<video>` pauses on iOS lock screen** | Accepted | Documented limitation. User taps play when returning. Resumes from position. |
| **fMP4 init segment sharing across paragraphs** | Low | All paragraphs from same Piper voice have identical audio params (22050 Hz, mono, 16-bit). Init segment is valid for all. |
| **Encode worker blocks on FFmpeg init** | Low | Worker is separate from TTS worker. Piper synth continues while FFmpeg loads. Encode queue absorbs delay. |
| **Memory: SourceBuffer accumulation** | Low | Call `sourceBuffer.remove()` to evict old ranges when buffered data exceeds ~5 min behind currentTime. Standard MSE practice. |
| **AAC quality at 64kbps mono** | Low | Speech at 64kbps mono is transparent. Noted for future tuning. |
| **Service worker caches stale M9 bundle** | Existing gotcha #3 | Test via `pnpm preview` + hard reload. |
| **Real-iPhone not verifiable via MCP** | Existing gotcha #5 | Desktop MCP verifies MSE mechanics + playback. Real device test is manual gate before public claim. |

## Tasks (ordered, dependency-chained)

| # | Task | Acceptance | Verify | Files |
| --- | --- | --- | --- | --- |
| T1 | Write ADR-0006 + spec | ADR + spec written. ROADMAP + AGENTS.md updated. | docs review | `docs/adrs/0006-*.md`, `docs/specs/mobile-streaming-deferred/spec.md`, `docs/ROADMAP.md`, `AGENTS.md` |
| T2 | Spike: FFmpeg WASM + MSE | (a) FFmpeg WASM loads in worker. (b) Encodes test WAV → valid fMP4 with AAC+H.264. (c) `MediaSource` + `SourceBuffer` on `<video>` plays fMP4. (d) `timestampOffset` sequences two segments correctly. | tests + Chrome DevTools MCP: zero console errors, audio plays, `sourceBuffer.buffered` shows expected ranges | `web/src/lib/audio/ffmpeg.ts` (initial), test file |
| T3 | FFmpeg WASM wrapper + encode worker | `initFfmpeg()` with OPFS loading + progress. `encodeWavToFmp4(wav): Promise<{fmp4, duration}>`. Worker protocol: receives `{wav}`, returns `{fmp4, duration}`. Lazy-loads core from OPFS/CDN. | unit test (mock worker round-trip) | `web/src/lib/audio/ffmpeg.ts`, `encode-worker.ts`, `.test.ts` |
| T4 | fMP4 segment IDB cache | `audioSegments` store in `taletrek` DB v4. `getSegment(key)`, `putSegment(key, blob, duration)`, `deleteBookSegments(bookId)`. LRU eviction reusing M8 pattern. | unit test (fake-indexeddb) | `web/src/lib/audio-segment-cache.ts`, `.test.ts`, `web/src/lib/db.ts` |
| T5 | MSE streaming controller | `MseController` class: `init(video, codec)`, `appendInit(data)`, `appendSegment(data)`, `setTimestampOffset(s)`, `seekTo(s)`, `onTimeUpdate(cb)`, `destroy()`. Handles `updateend` queueing (no overlapping appends). Old-range eviction via `sourceBuffer.remove()`. | unit test (mock MediaSource + SourceBuffer) | `web/src/lib/audio/mse.ts`, `.test.ts` |
| T6 | `useStreamingPlayer` hook | Returns `UseParagraphPlayerResult`. Manages: segment cache lookup → MSE init → progressive feeding → status variants. `timeupdate` → binary search offsets → `currentParagraphId`. | unit test (mock MseController + fake IDB) | `web/src/routes/reader/useStreamingPlayer.ts`, `.test.ts` |
| T7 | Navigation parity | `seekToParagraph(id)` → `video.currentTime = offset[id]`. `next`/`prev` → adjacent offset. `nextChapter`/`prevChapter` → first paragraph of target chapter. `navigateToParagraph` → seek without playing. `seekBy`/`seekTo` → within timeline. | unit test (offset mapping, chapter boundaries) | `useStreamingPlayer.ts` (extended) |
| T8 | Mode detection + ReaderPane wiring | `matchMedia('(pointer: coarse)')` selects engine. Both produce `UseParagraphPlayerResult`. FFmpeg lazy-loads on first mobile play. Loading indicator shown. | `ReaderView.test.tsx` extended | `web/src/routes/reader/ReaderPane.tsx`, `ReaderView.test.tsx` |
| T9 | Media Session + upload manager | Media Session works with streaming player (chapter-level duration/position). Upload manager encodes fMP4 segments during background synthesis. | `useMediaSession.test.ts` + `manager.test.ts` extended | `web/src/routes/reader/useMediaSession.ts` (if needed), `web/src/lib/upload/manager.ts` |
| T10 | Verify | Chrome DevTools MCP at mobile viewport: zero console errors, gapless through chapter, highlighting tracks, seek works, Media Session wired. Desktop regression: existing tests unchanged. `pnpm verify` green. Real-iPhone checklist documented. | full `pnpm verify` + Chrome DevTools MCP | wiring + minor fixes |

**Ordering:** T1 → T2 → (gate) → T3 → T4 → T5 → T6 → T7 → T8 → (T9 ∥) → T10.

**Checkpoints:** A (T2: spike passes) · B (T3–T4: encoding pipeline) · C (T5–T7: mobile player works in isolation) · D (T8–T9: integrated) · E (T10: shipped, verify green).

## Out of scope (future milestones or improvements)

- **Audio-only MSE optimization**: drop the 1x1 black H.264 frame if iOS Safari is later proven to accept audio-only fMP4 in MSE on `<video>`. Saves ~1KB/segment + removes H.264 encode overhead.
- **HLS native playback**: leverage iOS Safari's native HLS player for potentially better buffering and seeking. Requires AAC encoder + TS muxer + SW serving layer. Natural upgrade path if MSE proves limited.
- **Compression tuning**: AAC bitrate (64kbps → 32kbps or 96kbps), Opus codec exploration, variable bitrate.
- **Settings override for mode**: let users manually switch between streaming and per-paragraph engines regardless of device type.
- **Wake Lock integration**: `navigator.wakeLock.request('screen')` to prevent auto-lock during active reading (complementary to streaming — doesn't override manual lock button).
- **Background audio across chapters**: currently, audio pauses at chapter boundaries on mobile if the user doesn't interact. A future "super-chunk" approach (stitch multiple chapters into one MSE stream) could extend this.
- **OPFS pre-loading**: download FFmpeg core during book upload/open instead of waiting for first play.
