import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import type { Book, BookFile, BookId, Chapter, ChapterId } from '../types'

/**
 * TaleTrek IndexedDB schema.
 *
 * v1 (M0): `settings` store only.
 * v2 (M1): adds `books`, `chapters`, and `files` stores for the ingest pipeline.
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
}

const DB_NAME = 'taletrek'
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase<TaleTrekDB>> | null = null

/** Open (and memoize) the TaleTrek database. Safe to call repeatedly. */
export function getDB(): Promise<IDBPDatabase<TaleTrekDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TaleTrekDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings')
        }
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
        }
        if (!db.objectStoreNames.contains('chapters')) {
          db.createObjectStore('chapters', { keyPath: 'id' }).createIndex('bookId', 'bookId')
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'bookId' })
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

/** Return the most-recently-updated book, or `undefined` when none exist. */
export async function getMostRecentBook(): Promise<Book | undefined> {
  const db = await getDB()
  const books = await db.getAllFromIndex('books', 'updatedAt')
  return books.at(-1)
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

/** Remove all chapters belonging to a book. */
export async function deleteChaptersByBook(bookId: BookId): Promise<void> {
  const db = await getDB()
  const keys = await db.getAllKeysFromIndex('chapters', 'bookId', bookId)
  const tx = db.transaction('chapters', 'readwrite')
  await Promise.all(keys.map((k) => tx.store.delete(k)))
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
