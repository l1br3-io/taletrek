import type { AudioSegmentRecord, BookId, VoiceId } from '../types'
import { audioCacheKey } from './audio-cache'
import { getDB } from './db'

/**
 * fMP4 segment cache for mobile MSE streaming (M9).
 *
 * Each paragraph's PCM WAV is encoded to a fragmented MP4 segment (AAC + H.264)
 * and stored here, keyed identically to M8's `audioCache`
 * (`${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`). The segment cache
 * is separate from the WAV cache so desktop playback (M3/M8) is untouched.
 *
 * The cache follows the same patterns as `audio-cache.ts`: LRU-bounded,
 * per-book cascade clear, best-effort puts.
 */

/** Soft cap on the segment cache. fMP4 segments are ~10× smaller than WAV. */
const SEGMENT_CACHE_BUDGET_BYTES = 200 * 1024 * 1024

/**
 * Lookup a cached fMP4 segment by its content-addressed key. Bumps `lastUsed`
 * on hit so the LRU policy treats recently-played entries as hot.
 */
export async function getSegment(key: string): Promise<AudioSegmentRecord | undefined> {
  const db = await getDB()
  const record = await db.get('audioSegments', key)
  if (!record) return undefined
  const bumped: AudioSegmentRecord = { ...record, lastUsed: Date.now() }
  await db.put('audioSegments', bumped)
  return bumped
}

/**
 * Insert (or overwrite) a segment. Best-effort: quota errors trigger an LRU
 * sweep and retry; if it still fails the put is dropped silently (encoding
 * already succeeded — the cache is best-effort).
 */
export async function putSegment(
  key: string,
  blob: Blob,
  duration: number,
  meta: { bookId?: BookId; voiceId: VoiceId },
): Promise<void> {
  const now = Date.now()
  const record: AudioSegmentRecord = {
    key,
    blob,
    duration,
    sizeBytes: blob.size,
    lastUsed: now,
    createdAt: now,
    ...(meta.bookId !== undefined ? { bookId: meta.bookId } : {}),
  }
  const db = await getDB()
  try {
    await db.put('audioSegments', record)
  } catch (err) {
    if (!isQuotaExceededError(err)) throw err
    await evictSegmentFraction(0.5)
    try {
      await db.put('audioSegments', record)
    } catch {
      // Best-effort — encoding already produced the segment; drop the cache write.
    }
    return
  }
  const size = await getSegmentCacheSize()
  if (size > SEGMENT_CACHE_BUDGET_BYTES) {
    await evictSegmentToBudget(SEGMENT_CACHE_BUDGET_BYTES)
  }
}

/** Total bytes across all segment entries. */
export async function getSegmentCacheSize(): Promise<number> {
  const db = await getDB()
  const tx = db.transaction('audioSegments', 'readonly')
  let total = 0
  let cursor = await tx.store.openCursor()
  while (cursor) {
    total += cursor.value.sizeBytes
    cursor = await cursor.continue()
  }
  await tx.done
  return total
}

/** All segment keys for a book (for cascade delete). */
export async function getSegmentKeysByBook(bookId: BookId): Promise<string[]> {
  const db = await getDB()
  return db.getAllKeysFromIndex('audioSegments', 'bookId', bookId)
}

/** Delete specific segment entries by key. Returns the count removed. */
export async function deleteSegmentKeys(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0
  const db = await getDB()
  const tx = db.transaction('audioSegments', 'readwrite')
  await Promise.all(keys.map((k) => tx.store.delete(k)))
  await tx.done
  return keys.length
}

/** Evict oldest by `lastUsed` until total ≤ budget. Returns count removed. */
export async function evictSegmentToBudget(budgetBytes: number): Promise<number> {
  const db = await getDB()
  let total = await getSegmentCacheSize()
  if (total <= budgetBytes) return 0
  let removed = 0
  const tx = db.transaction('audioSegments', 'readwrite')
  let cursor = await tx.store.index('lastUsed').openCursor()
  while (cursor && total > budgetBytes) {
    total -= cursor.value.sizeBytes
    await cursor.delete()
    removed++
    cursor = await cursor.continue()
  }
  await tx.done
  return removed
}

/** Evict a fraction (0..1) of segments by oldest-first (panic recovery). */
export async function evictSegmentFraction(fraction: number): Promise<number> {
  const db = await getDB()
  const count = await db.count('audioSegments')
  const toRemove = Math.max(1, Math.ceil(count * fraction))
  let removed = 0
  const tx = db.transaction('audioSegments', 'readwrite')
  let cursor = await tx.store.index('lastUsed').openCursor()
  while (cursor && removed < toRemove) {
    await cursor.delete()
    removed++
    cursor = await cursor.continue()
  }
  await tx.done
  return removed
}

/** Clear the entire segment cache. Returns count removed. */
export async function clearSegmentCache(): Promise<number> {
  const db = await getDB()
  const count = await db.count('audioSegments')
  await db.clear('audioSegments')
  return count
}

/**
 * Try to get a segment by voice + text. Computes the cache key, looks up the
 * segment, and returns it on hit. Convenience wrapper around `getSegment`.
 */
export async function lookupSegment(
  voiceId: VoiceId,
  text: string,
): Promise<AudioSegmentRecord | undefined> {
  const key = await audioCacheKey(voiceId, text)
  return getSegment(key)
}

/**
 * Store a freshly encoded fMP4 segment. Convenience wrapper that computes the
 * cache key from voice + text and delegates to `putSegment`.
 */
export async function storeSegment(
  voiceId: VoiceId,
  text: string,
  blob: Blob,
  duration: number,
  meta: { bookId?: BookId },
): Promise<void> {
  const key = await audioCacheKey(voiceId, text)
  await putSegment(key, blob, duration, { ...meta, voiceId })
}

function isQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  )
}
