import type { AudioCacheRecord, BookId, Chapter, VoiceId } from '../types'
import { getAudioCacheEntry, getAudioCacheKeysByBook, putAudioCacheEntry } from './db'
import { NORM_VERSION, normalizeForSpeech } from './tts/normalize'

/**
 * Audio cache key builder + lookup/put helpers (M8).
 *
 * The key is content-addressed: `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`.
 * Every input that affects synthesis is in the key, so a voice change, a
 * normalize-logic change (via `NORM_VERSION` bump), or a text change all
 * produce natural cache misses. `playbackRate` is intentionally excluded —
 * it's applied live on the `<audio>` element, not baked into the WAV, so one
 * blob serves any speed.
 *
 * Hashing the *normalized* text (not the raw) means two source paragraphs
 * that normalize to the same string share one cache entry.
 */

/** Build the content-addressed cache key for a synthesis request. */
export async function audioCacheKey(
  voiceId: VoiceId,
  text: string,
  normVersion: string = NORM_VERSION,
): Promise<string> {
  const normalized = normalizeForSpeech(text)
  const hash = await sha256Hex(normalized)
  return `${voiceId}:${normVersion}:${hash}`
}

/**
 * Try the cache for a pre-rendered blob. Returns the record on hit (with
 * `lastUsed` bumped), or `undefined` on miss. The hit path is what makes
 * resume-after-reload instant — no Piper inference, just an IDB read.
 */
export async function lookupAudioCache(key: string): Promise<AudioCacheRecord | undefined> {
  return getAudioCacheEntry(key)
}

/**
 * Store a freshly synthesized audio blob. Best-effort: any IDB failure
 * (quota, eviction sweep) is swallowed — synthesis already produced the
 * audio and returned it to the caller; the cache write is purely a local
 * optimization. `putAudioCacheEntry` runs the LRU sweep internally.
 */
export async function storeAudioCache(
  key: string,
  blob: Blob,
  meta: { bookId?: BookId; voiceId: VoiceId; synthMs: number; durationSeconds: number },
): Promise<void> {
  const now = Date.now()
  const record: AudioCacheRecord = {
    key,
    blob,
    sizeBytes: blob.size,
    synthMs: meta.synthMs,
    durationSeconds: meta.durationSeconds,
    voiceId: meta.voiceId,
    lastUsed: now,
    createdAt: now,
    ...(meta.bookId !== undefined ? { bookId: meta.bookId } : {}),
  }
  try {
    await putAudioCacheEntry(record)
  } catch {
    // Non-fatal — see jsdoc.
  }
}

/** SHA-256 of a string, hex-encoded. Uses `crypto.subtle` (available in workers). */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bufferToHex(digest)
}

/**
 * Compute the set of positional paragraph IDs (`${chapterId}:${index}`) that
 * are currently cached for a given book + voice. Uses a single bulk IDB query
 * (`getAudioCacheKeysByBook`) then checks each paragraph's computed key against
 * the result set — no per-paragraph IDB round-trips.
 *
 * Pass **cleaned** chapters so the key derivation matches what the engine
 * produces at synth time.
 */
export async function getCachedParagraphIds(
  bookId: BookId,
  voiceId: VoiceId,
  chapters: Chapter[],
): Promise<Set<string>> {
  const cachedKeys = new Set(await getAudioCacheKeysByBook(bookId))
  const result = new Set<string>()
  for (const ch of chapters) {
    for (const [i, text] of ch.paragraphs.entries()) {
      if (!text.trim()) continue
      const key = await audioCacheKey(voiceId, text)
      if (cachedKeys.has(key)) {
        result.add(`${ch.id}:${i}`)
      }
    }
  }
  return result
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}
