import type { Book, BookId, BookPosition } from '../../types'
import type { AppliedProcessing } from '../ai/types'
import { getDB } from './connection'

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
 * Remove a book together with all of its chapters, its uploaded file, its
 * cached audio (M8), and its fMP4 segments (M9). Runs in a single transaction
 * so the cascade is atomic.
 *
 * Resilient to schema drift: only stores that actually exist on the open DB
 * are touched. A dev DB can land at the current schema version with newer
 * stores missing if `DB_VERSION` was bumped in a prior code state before the
 * matching upgrade branch existed — IndexedDB won't re-run `onupgradeneeded`
 * at the same version, so the gap persists. Skipping absent stores keeps the
 * cascade working on such a DB instead of throwing `NotFoundError`.
 */
export async function deleteBookCascade(id: BookId): Promise<void> {
  const db = await getDB()
  const cascadeStores = CASCADE_STORES.filter((s) => db.objectStoreNames.contains(s))
  const has = (name: CascadeStore): boolean => cascadeStores.includes(name)

  const chapterKeys = has('chapters') ? await db.getAllKeysFromIndex('chapters', 'bookId', id) : []
  const audioKeys = has('audioCache')
    ? await db.getAllKeysFromIndex('audioCache', 'bookId', id)
    : []
  const segmentKeys = has('audioSegments')
    ? await db.getAllKeysFromIndex('audioSegments', 'bookId', id)
    : []

  const tx = db.transaction(cascadeStores as CascadeStore[], 'readwrite')
  await Promise.all(
    [
      has('books') && tx.objectStore('books').delete(id),
      ...chapterKeys.map((key) => tx.objectStore('chapters').delete(key)),
      has('files') && tx.objectStore('files').delete(id),
      ...audioKeys.map((key) => tx.objectStore('audioCache').delete(key)),
      ...segmentKeys.map((key) => tx.objectStore('audioSegments').delete(key)),
      has('bookAudio') && tx.objectStore('bookAudio').delete(id),
    ].filter((p) => p !== false) as Promise<unknown>[],
  )
  await tx.done
}

/** Stores that may hold book-owned data and should be cleared on delete. */
const CASCADE_STORES = [
  'books',
  'chapters',
  'files',
  'audioCache',
  'audioSegments',
  'bookAudio',
] as const
type CascadeStore = (typeof CASCADE_STORES)[number]

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
