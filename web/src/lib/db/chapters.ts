import type { BookId, Chapter, ChapterId } from '../../types'
import { getDB } from './connection'

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
