import type { AudioCacheRecord, BookId } from '../../types'
import { getDB } from './connection'
import { getEffectiveAudioCacheBudget } from './settings'

let pinnedBookId: BookId | null = null

/**
 * Pin entries for the given book so they are skipped by LRU eviction. Used
 * during an upload/resynth job so the cache does not evict paragraphs it is
 * still in the process of synthesizing. Pass `null` to clear the pin.
 */
export function setPinnedAudioCacheBookId(bookId: BookId | null): void {
  pinnedBookId = bookId
}

/**
 * Lookup a cached audio entry by its content-addressed key. Bumps `lastUsed`
 * on hit so the LRU eviction policy treats recently-played entries as hot.
 * Returns `undefined` on miss.
 */
export async function getAudioCacheEntry(key: string): Promise<AudioCacheRecord | undefined> {
  const db = await getDB()
  const record = await db.get('audioCache', key)
  if (!record) return undefined
  const bumped: AudioCacheRecord = { ...record, lastUsed: Date.now() }
  await db.put('audioCache', bumped)
  return bumped
}

/**
 * Insert (or overwrite) a cache entry. After the write, if total cache size
 * exceeds the effective budget, runs an LRU sweep. On `QuotaExceededError`,
 * evicts half the cache by `lastUsed` and retries once; if it still fails
 * the put is dropped silently (synthesis already succeeded — the cache is
 * best-effort).
 *
 * A budget of `Infinity` (no-limit synth mode) disables the reactive sweep
 * entirely; the QuotaExceeded panic path still runs because physical quota
 * is unavoidable.
 */
export async function putAudioCacheEntry(record: AudioCacheRecord): Promise<void> {
  const db = await getDB()
  try {
    await db.put('audioCache', record)
  } catch (err) {
    if (!isQuotaExceededError(err)) throw err
    await evictAudioCacheFraction(0.5)
    try {
      await db.put('audioCache', record)
    } catch {
      // Best-effort: synthesis already produced the audio; drop the cache write.
    }
    return
  }
  // Reactive sweep: keep total at or below the effective budget after each
  // write. Skip when the budget is Infinity (no-limit mode lets the cache
  // grow until the browser's physical quota is hit).
  const budget = await getEffectiveAudioCacheBudget()
  if (Number.isFinite(budget)) {
    const size = await getAudioCacheSize()
    if (size > budget) {
      await evictAudioCacheToBudget(budget)
    }
  }
}

/** Total bytes across all cache entries. */
export async function getAudioCacheSize(): Promise<number> {
  const db = await getDB()
  const tx = db.transaction('audioCache', 'readonly')
  let total = 0
  let cursor = await tx.store.openCursor()
  while (cursor) {
    total += cursor.value.sizeBytes
    cursor = await cursor.continue()
  }
  await tx.done
  return total
}

/** All cache keys for a book (for cascade delete + diagnostics). Uses the `bookId` index. */
export async function getAudioCacheKeysByBook(bookId: BookId): Promise<string[]> {
  const db = await getDB()
  return db.getAllKeysFromIndex('audioCache', 'bookId', bookId)
}

/**
 * Delete specific cache entries by key. Used by per-book re-synthesize to
 * clear the book's stale audio before rebuilding it (without touching other
 * books' cache). Runs in a single transaction. Returns the count removed.
 */
export async function deleteAudioCacheKeys(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0
  const db = await getDB()
  const tx = db.transaction('audioCache', 'readwrite')
  await Promise.all(keys.map((k) => tx.store.delete(k)))
  await tx.done
  return keys.length
}

/**
 * Evict oldest entries by `lastUsed` until total ≤ `budgetBytes`. Returns the
 * count removed. Walks the `lastUsed` index ascending (oldest first).
 */
export async function evictAudioCacheToBudget(budgetBytes: number): Promise<number> {
  const db = await getDB()
  let total = await getAudioCacheSize()
  if (total <= budgetBytes) return 0
  let removed = 0
  const tx = db.transaction('audioCache', 'readwrite')
  let cursor = await tx.store.index('lastUsed').openCursor()
  while (cursor && total > budgetBytes) {
    if (cursor.value.bookId !== pinnedBookId) {
      total -= cursor.value.sizeBytes
      await cursor.delete()
      removed++
    }
    cursor = await cursor.continue()
  }
  await tx.done
  return removed
}

/**
 * Evict a fraction (0..1) of the cache by oldest-first. Used as the panic
 * recovery path on `QuotaExceededError` — frees up substantial space fast.
 */
export async function evictAudioCacheFraction(fraction: number): Promise<number> {
  const db = await getDB()
  const count = await db.count('audioCache')
  const toRemove = Math.max(1, Math.ceil(count * fraction))
  let removed = 0
  const tx = db.transaction('audioCache', 'readwrite')
  let cursor = await tx.store.index('lastUsed').openCursor()
  while (cursor && removed < toRemove) {
    if (cursor.value.bookId !== pinnedBookId) {
      await cursor.delete()
      removed++
    }
    cursor = await cursor.continue()
  }
  await tx.done
  return removed
}

/** Clear the entire audio cache. Returns the count removed. */
export async function clearAudioCache(): Promise<number> {
  const db = await getDB()
  const count = await db.count('audioCache')
  await db.clear('audioCache')
  return count
}

/** Best-effort detection of quota-exceeded across browsers. */
export function isQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  )
}
