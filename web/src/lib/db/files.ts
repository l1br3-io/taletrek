import type { BookFile, BookId } from '../../types'
import { getDB } from './connection'

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
