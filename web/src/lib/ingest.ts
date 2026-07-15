import type { Book, BookFile, Chapter } from '../types'
import { newBookId, newChapterId } from '../types'
import { putBook, putBookFile, putChapters } from './db'
import { parseInWorker } from './parse/client'
import { formatForFile } from './parse/util'

export interface IngestResult {
  book: Book
  chapters: Chapter[]
}

export class UnsupportedFileError extends Error {
  override readonly name = 'UnsupportedFileError'
  constructor(fileName: string) {
    super(`Unsupported file type: ${fileName}`)
  }
}

/**
 * Parse an uploaded file, persist it (book + chapters + raw blob), and return
 * the new records. Shared by the library and reader upload flows. Throws
 * `UnsupportedFileError` for an unrecognized extension, or propagates parse
 * errors from the worker.
 */
export async function ingestBook(file: File): Promise<IngestResult> {
  const format = formatForFile(file.name)
  if (!format) throw new UnsupportedFileError(file.name)

  const result = await parseInWorker(file)
  const now = Date.now()
  const id = newBookId()
  const book: Book = {
    id,
    title: result.title,
    format,
    chapterCount: result.chapters.length,
    createdAt: now,
    updatedAt: now,
    uploading: true,
  }
  const chapters: Chapter[] = result.chapters.map((parsed, index) => ({
    id: newChapterId(),
    bookId: id,
    index,
    title: parsed.title,
    paragraphs: parsed.paragraphs,
  }))
  const bookFile: BookFile = {
    bookId: id,
    blob: file,
    name: file.name,
    type: file.type,
    size: file.size,
  }
  await Promise.all([putBook(book), putChapters(chapters), putBookFile(bookFile)])
  return { book, chapters }
}
