import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import type {
  AudioCacheRecord,
  Book,
  BookFile,
  BookId,
  BookPosition,
  Chapter,
  ChapterId,
} from '../types'
import type { AppliedProcessing } from './ai/types'

/**
 * TaleTrek IndexedDB schema.
 *
 * v1 (M0): `settings` store only.
 * v2 (M1): adds `books`, `chapters`, and `files` stores for the ingest pipeline.
 * v3 (M8): adds `audioCache` store for the persistent TTS audio cache.
 */
export interface TaleTrekDB extends DBSchema {
  settings: {
    key: string
    value: unknown
  }
  books: {
    key: BookId
    value: Book
    indexes: { updatedAt: number }
  }
  chapters: {
    key: ChapterId
    value: Chapter
    indexes: { bookId: BookId }
  }
  files: {
    key: BookId
    value: BookFile
  }
  audioCache: {
    key: string
    value: AudioCacheRecord
    indexes: { bookId: BookId; lastUsed: number }
  }
}

const DB_NAME = 'taletrek'
const DB_VERSION = 3

/** Soft cap on the audio cache (M8). ~1,700 paragraphs at ~300 KB/para. */
export const AUDIO_CACHE_BUDGET_BYTES = 500 * 1024 * 1024

/** Private settings key for the current audio cache budget in bytes. Written
 * by `SettingsProvider`, read by `getEffectiveAudioCacheBudget` (which runs
 * inside the TTS worker — can't share module state with the main thread). */
const AUDIO_CACHE_BUDGET_KEY = '__audioCacheBudgetBytes'

/** Write the effective audio cache budget (bytes) to IDB so the TTS worker
 * can read it. Called by `SettingsProvider` on hydration + budget changes. */
export async function syncAudioCacheBudget(bytes: number): Promise<void> {
  await setSetting(AUDIO_CACHE_BUDGET_KEY, bytes)
}

/** Read the effective audio cache budget from IDB, falling back to the
 * 500 MB default. Safe to call from the TTS worker (shared IDB). */
export async function getEffectiveAudioCacheBudget(): Promise<number> {
  const stored = await getSetting<number>(AUDIO_CACHE_BUDGET_KEY)
  return stored ?? AUDIO_CACHE_BUDGET_BYTES
}

let dbPromise: Promise<IDBPDatabase<TaleTrekDB>> | null = null

/** Open (and memoize) the TaleTrek database. Safe to call repeatedly. */
export function getDB(): Promise<IDBPDatabase<TaleTrekDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TaleTrekDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings')
          }
        }
        // v2
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('books')) {
            db.createObjectStore('books', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
          }
          if (!db.objectStoreNames.contains('chapters')) {
            db.createObjectStore('chapters', { keyPath: 'id' }).createIndex('bookId', 'bookId')
          }
          if (!db.objectStoreNames.contains('files')) {
            db.createObjectStore('files', { keyPath: 'bookId' })
          }
        }
        // v3 (M8)
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains('audioCache')) {
            const store = db.createObjectStore('audioCache', { keyPath: 'key' })
            store.createIndex('bookId', 'bookId')
            store.createIndex('lastUsed', 'lastUsed')
          }
        }
      },
    })
  }
  return dbPromise
}

/** Reset the memoized connection — test-only escape hatch. */
export function _resetDBForTests(): void {
  dbPromise = null
}

/** Clear every store — test-only isolation helper. Call after `_resetDBForTests`. */
export async function _clearDBForTests(): Promise<void> {
  const db = await getDB()
  await Promise.all([
    db.clear('settings'),
    db.clear('books'),
    db.clear('chapters'),
    db.clear('files'),
    db.clear('audioCache'),
  ])
}

/** Read a setting value by key, or `undefined` if absent. */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await getDB()
  return (await db.get('settings', key)) as T | undefined
}

/** Write a setting value, overwriting any existing value for that key. */
export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await getDB()
  await db.put('settings', value, key)
}

/** Remove a setting value. No-op if the key does not exist. */
export async function deleteSetting(key: string): Promise<void> {
  const db = await getDB()
  await db.delete('settings', key)
}

/** Read a book by id, or `undefined` if absent. */
export async function getBook(id: BookId): Promise<Book | undefined> {
  const db = await getDB()
  return db.get('books', id)
}

/** Write a book record (insert or overwrite). */
export async function putBook(book: Book): Promise<void> {
  const db = await getDB()
  await db.put('books', book)
}

/** Remove a book record. Does not cascade to chapters/files. */
export async function deleteBook(id: BookId): Promise<void> {
  const db = await getDB()
  await db.delete('books', id)
}

/**
 * Remove a book together with all of its chapters, its uploaded file, and its
 * cached audio (M8). Runs in a single transaction so the cascade is atomic.
 */
export async function deleteBookCascade(id: BookId): Promise<void> {
  const db = await getDB()
  const chapterKeys = await db.getAllKeysFromIndex('chapters', 'bookId', id)
  const audioKeys = await db.getAllKeysFromIndex('audioCache', 'bookId', id)
  const tx = db.transaction(['books', 'chapters', 'files', 'audioCache'], 'readwrite')
  await Promise.all([
    tx.objectStore('books').delete(id),
    ...chapterKeys.map((key) => tx.objectStore('chapters').delete(key)),
    tx.objectStore('files').delete(id),
    ...audioKeys.map((key) => tx.objectStore('audioCache').delete(key)),
  ])
  await tx.done
}

/**
 * Lightweight progress write — preserves the other book fields, sets
 * `position` + `progressFraction`, and bumps `updatedAt` so the book sorts to
 * the top of the library / `getMostRecentBook`. No-op if the book is gone.
 */
export async function updateBookProgress(
  id: BookId,
  position: BookPosition,
  progressFraction: number,
): Promise<void> {
  const db = await getDB()
  const book = await db.get('books', id)
  if (!book) return
  book.position = position
  book.progressFraction = progressFraction
  book.updatedAt = Date.now()
  await db.put('books', book)
}

/**
 * Set or clear a book's applied-processing record (M6). Passing `undefined`
 * clears it (e.g. on re-process-from-originals). Bumps `updatedAt`. No-op if
 * the book is gone. The key invariant: **position is reset separately** by the
 * caller via `updateBookProgress` (keep `chapterIndex`, reset `paragraphIndex`).
 */
export async function updateBookProcessing(
  id: BookId,
  processing: AppliedProcessing | undefined,
): Promise<void> {
  const db = await getDB()
  const book = await db.get('books', id)
  if (!book) return
  if (processing) book.processing = processing
  else delete book.processing
  book.updatedAt = Date.now()
  await db.put('books', book)
}

/** Return the most-recently-updated book, or `undefined` when none exist. */
export async function getMostRecentBook(): Promise<Book | undefined> {
  const db = await getDB()
  const books = await db.getAllFromIndex('books', 'updatedAt')
  return books.at(-1)
}

/** All books, newest-first by `updatedAt`. */
export async function getAllBooks(): Promise<Book[]> {
  const db = await getDB()
  const books = await db.getAllFromIndex('books', 'updatedAt')
  return books.reverse()
}

/** Write chapters (insert or overwrite). */
export async function putChapters(chapters: Chapter[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('chapters', 'readwrite')
  await Promise.all(chapters.map((c) => tx.store.put(c)))
  await tx.done
}

/** Return all chapters for a book, ordered by chapter index. */
export async function getChaptersByBook(bookId: BookId): Promise<Chapter[]> {
  const db = await getDB()
  const chapters = await db.getAllFromIndex('chapters', 'bookId', bookId)
  return chapters.sort((a, b) => a.index - b.index)
}

/**
 * Overwrite a single paragraph's text within a chapter (M6 per-paragraph
 * transform). Returns the updated chapter, or `undefined` if the chapter or
 * paragraph index is out of range.
 */
export async function updateParagraph(
  chapterId: ChapterId,
  paragraphIndex: number,
  text: string,
): Promise<Chapter | undefined> {
  const db = await getDB()
  const chapter = await db.get('chapters', chapterId)
  if (!chapter) return undefined
  if (paragraphIndex < 0 || paragraphIndex >= chapter.paragraphs.length) return undefined
  const paragraphs = chapter.paragraphs.slice()
  paragraphs[paragraphIndex] = text
  const next: Chapter = { ...chapter, paragraphs }
  await db.put('chapters', next)
  return next
}

/** Remove all chapters belonging to a book. */
export async function deleteChaptersByBook(bookId: BookId): Promise<void> {
  const db = await getDB()
  const keys = await db.getAllKeysFromIndex('chapters', 'bookId', bookId)
  const tx = db.transaction('chapters', 'readwrite')
  await Promise.all(keys.map((k) => tx.store.delete(k)))
  await tx.done
}

/** Remove specific chapters by ID (e.g. stale tail chapters after a re-parse). */
export async function deleteChaptersByIds(ids: ChapterId[]): Promise<void> {
  if (ids.length === 0) return
  const db = await getDB()
  const tx = db.transaction('chapters', 'readwrite')
  await Promise.all(ids.map((id) => tx.store.delete(id)))
  await tx.done
}

/**
 * Atomically replace all chapters for a book with `newChapters` and update
 * `chapterCount` + `updatedAt` on the book record. Used by outline
 * regeneration — the new chapter structure is unrelated to the old one, so
 * all old chapters are deleted and fresh IDs are assigned. Runs in a single
 * transaction so a crash mid-write never leaves the book chapter-less.
 */
export async function replaceBookChapters(bookId: BookId, newChapters: Chapter[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['chapters', 'books'], 'readwrite')
  const chapterStore = tx.objectStore('chapters')
  const chapterKeys = await chapterStore.index('bookId').getAllKeys(bookId)
  await Promise.all(chapterKeys.map((key) => chapterStore.delete(key)))
  await Promise.all(newChapters.map((c) => chapterStore.put(c)))
  const book = await tx.objectStore('books').get(bookId)
  if (book) {
    book.chapterCount = newChapters.length
    book.updatedAt = Date.now()
    await tx.objectStore('books').put(book)
  }
  await tx.done
}

/** Store the raw uploaded blob for a book (source of truth). */
export async function putBookFile(file: BookFile): Promise<void> {
  const db = await getDB()
  await db.put('files', file)
}

/** Read the raw blob for a book, or `undefined` if absent. */
export async function getBookFile(bookId: BookId): Promise<BookFile | undefined> {
  const db = await getDB()
  return db.get('files', bookId)
}

/** Remove the raw blob for a book. */
export async function deleteBookFile(bookId: BookId): Promise<void> {
  const db = await getDB()
  await db.delete('files', bookId)
}

// ---------------------------------------------------------------------------
// Audio cache (M8) — persistent content-addressed TTS audio. See
// `lib/audio-cache.ts` for key construction + the higher-level lookup/put API
// used by `PiperEngine`. These helpers are the thin IDB layer.
// ---------------------------------------------------------------------------

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
    total -= cursor.value.sizeBytes
    await cursor.delete()
    removed++
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
    await cursor.delete()
    removed++
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
function isQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  )
}
