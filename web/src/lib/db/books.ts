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
