# Plan: M8.1 — iOS Huge-Book Upload Resilience

> Status: ✅ Complete — verified 2026-07-18 (`pnpm typecheck`, 811 tests, `pnpm verify`).

## Problem

On iOS Safari, uploading a large PDF could fail during the synthesizing stage with a `DOMException`. Investigation showed the failure was a combination of:

1. **Main-thread WAV round-trip.** `preSynthesizeBook` cloned every synthesized WAV `Blob` from the TTS worker to the main thread just to parse its duration. On memory-constrained iOS devices this created a cross-process blob-read surface that could throw `NotReadableError` under pressure.
2. **Self-eviction during upload.** The 500 MB LRU audio cache could evict the book's own earliest paragraphs while it was still being synthesized, causing a deterministic cache miss later during mobile whole-book encode.
3. **Unbounded mobile encode.** The concat worker loaded **all** WAV paragraphs into FFmpeg MEMFS and produced a single m4a, which could exceed iOS storage quota and worker RAM for very long books.
4. **Opaque / fatal error handling.** Worker errors were flattened to plain `Error(message)`, losing the DOMException name/code needed for diagnosis; worker crashes produced silent hangs; and any initial-upload failure cascade-deleted the book, even for transient storage-pressure errors.

## Changes

### Phase 1 — Remove the WAV main-thread round-trip
- `SynthesisRequest` gained `returnAudio?: boolean`; `SynthesisResult` now always returns `durationSeconds` and `cacheKey`, with `audio` optional.
- `preSynthesizeBook` passes `returnAudio: false`; the worker computes duration in-process and never structured-clones the WAV back to the main thread.
- `AudioCacheRecord` gained `durationSeconds` so cache hits can return duration without re-parsing the blob.
- `useDesktopPlayer` guards against a missing `audio` blob (desktop playback still receives it).

### Phase 2 — Pin the uploading book's cache entries
- Added `setPinnedAudioCacheBookId` to `lib/db/audio-cache.ts`.
- `evictAudioCacheToBudget` / `evictAudioCacheFraction` skip records whose `bookId` matches the pinned book.
- `UploadManager.runJob` sets the pin at start and clears it in `finally`.

### Phase 3 — Encode-size guard + quota-resilient m4a put
- `manager.ts` estimates the mobile m4a size before encoding (`durationSeconds × 8000 B/s`).
- If the estimate exceeds `MAX_MOBILE_M4A_BYTES` (~200 MB), `encodeBook` is skipped and the upload succeeds.
- `putBookAudio` catches `QuotaExceededError`, evicts non-pinned cache entries, retries once, and skips the encode if quota persists.
- `usePlayer` falls back to the desktop per-paragraph engine on mobile when no `bookAudio` exists.

### Phase 4 — Error identity, crash rejection, keep-and-retry
- TTS and concat worker protocols now include `name`/`code` on errors.
- Main-thread clients reconstruct `DOMException` and reject pending requests on worker `error`/`messageerror`.
- `UploadManager` logs a structured error object (`stage`, `done/total`, `name`, `code`, `message`, `stack`).
- Transient storage errors (`QuotaExceededError`, `NotReadableError`, `UnknownError`) in `initial` mode keep the book, clear the `uploading` flag, and mark the error state as `retryable`; the `GlobalUploadBanner` shows a Retry button.

## Files changed

- `web/src/lib/tts/types.ts`
- `web/src/lib/tts/protocol.ts`
- `web/src/lib/tts/engine.ts`
- `web/src/lib/tts/client.ts`
- `web/src/workers/tts.worker.ts`
- `web/src/lib/pre-synth.ts`
- `web/src/lib/audio/concat-protocol.ts`
- `web/src/lib/audio/concat-client.ts`
- `web/src/workers/concat.worker.ts`
- `web/src/lib/db/audio-cache.ts`
- `web/src/lib/db/index.ts`
- `web/src/lib/upload/manager.ts`
- `web/src/lib/book-audio.ts` (no change in this hotfix, but kept as dumb put wrapper)
- `web/src/routes/reader/players/useDesktopPlayer.ts`
- `web/src/routes/reader/players/usePlayer.ts`
- `web/src/components/GlobalUploadBanner.tsx`
- `web/src/types.ts` (`AudioCacheRecord.durationSeconds`)
- Tests: `engine.test.ts`, `client.test.ts`, `concat-client.test.ts` (new), `audio-cache.test.ts`, `pre-synth.test.ts`, `manager.test.ts`, `db.test.ts`, `library.test.tsx`, `reader.test.tsx`, `useParagraphPlayer.test.ts`, `settings.test.tsx`, `useAudioCacheStats.test.ts`, `backup.test.ts`
- Docs: `AGENTS.md`, this plan file

## Verification

- `pnpm typecheck` green
- `pnpm test` green (811 tests)
- `pnpm verify` green

## Follow-up

M9 (mobile streaming) is still the structural fix that removes the whole-book encode cap entirely by encoding per-paragraph fMP4 segments and feeding them to an MSE `<video>` element.
