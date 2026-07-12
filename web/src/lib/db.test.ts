import { beforeEach, describe, expect, it } from 'vitest'
import { type Book, type BookFile, type Chapter, newBookId, newChapterId } from '../types'
import type { AppliedProcessing } from './ai/types'
import {
  _clearDBForTests,
  _resetDBForTests,
  deleteBookCascade,
  deleteSetting,
  getAllBooks,
  getBook,
  getBookFile,
  getChaptersByBook,
  getSetting,
  putBook,
  putBookFile,
  putChapters,
  setSetting,
  updateBookProcessing,
  updateBookProgress,
} from './db'

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('settings store', () => {
  it('round-trips a value through IndexedDB', async () => {
    await setSetting('theme', 'dark')
    expect(await getSetting('theme')).toBe('dark')
  })

  it('returns undefined for a missing key', async () => {
    expect(await getSetting('nope')).toBeUndefined()
  })

  it('overwrites an existing value', async () => {
    await setSetting('voice', 'piper-en')
    await setSetting('voice', 'piper-fr')
    expect(await getSetting('voice')).toBe('piper-fr')
  })

  it('deletes a value', async () => {
    await setSetting('speed', 1.25)
    await deleteSetting('speed')
    expect(await getSetting('speed')).toBeUndefined()
  })

  it('survives a connection reopen (durable across sessions)', async () => {
    await setSetting('position', { chapter: 3, offset: 1024 })
    _resetDBForTests()
    expect(await getSetting('position')).toEqual({ chapter: 3, offset: 1024 })
  })
})

function makeBook(overrides: Partial<Book> = {}): Book {
  const now = Date.now()
  return {
    id: newBookId(),
    title: 'Test Book',
    format: 'txt',
    chapterCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('books store', () => {
  it('round-trips a book through IndexedDB', async () => {
    const { putBook, getBook } = await import('./db')
    const book = makeBook({ title: 'Moby Dick' })
    await putBook(book)
    expect(await getBook(book.id)).toEqual(book)
  })

  it('returns undefined for a missing book', async () => {
    const { getBook } = await import('./db')
    expect(await getBook(newBookId())).toBeUndefined()
  })

  it('getMostRecentBook returns the book with the highest updatedAt', async () => {
    const { putBook, getMostRecentBook } = await import('./db')
    const oldest = makeBook({ updatedAt: 1000 })
    const newest = makeBook({ updatedAt: 3000 })
    const middle = makeBook({ updatedAt: 2000 })
    await putBook(oldest)
    await putBook(newest)
    await putBook(middle)
    expect(await getMostRecentBook()).toEqual(newest)
  })

  it('getMostRecentBook returns undefined when no books exist', async () => {
    const { getMostRecentBook } = await import('./db')
    expect(await getMostRecentBook()).toBeUndefined()
  })

  it('deletes a book', async () => {
    const { putBook, deleteBook, getBook } = await import('./db')
    const book = makeBook()
    await putBook(book)
    await deleteBook(book.id)
    expect(await getBook(book.id)).toBeUndefined()
  })
})

describe('chapters store', () => {
  it('returns chapters for a book ordered by index', async () => {
    const { putChapters, getChaptersByBook } = await import('./db')
    const bookId = newBookId()
    const chapters: Chapter[] = [
      { id: newChapterId(), bookId, index: 2, title: 'C2', paragraphs: ['two'] },
      { id: newChapterId(), bookId, index: 0, title: 'C0', paragraphs: ['zero'] },
      { id: newChapterId(), bookId, index: 1, title: 'C1', paragraphs: ['one'] },
    ]
    await putChapters(chapters)
    const result = await getChaptersByBook(bookId)
    expect(result.map((c) => c.index)).toEqual([0, 1, 2])
  })

  it('returns an empty array when a book has no chapters', async () => {
    const { getChaptersByBook } = await import('./db')
    expect(await getChaptersByBook(newBookId())).toEqual([])
  })

  it('deletes chapters for a book', async () => {
    const { putChapters, getChaptersByBook, deleteChaptersByBook } = await import('./db')
    const bookId = newBookId()
    await putChapters([{ id: newChapterId(), bookId, index: 0, title: 'C0', paragraphs: ['x'] }])
    await deleteChaptersByBook(bookId)
    expect(await getChaptersByBook(bookId)).toEqual([])
  })
})

describe('files store', () => {
  it('round-trips a raw file record through IndexedDB', async () => {
    const { putBookFile, getBookFile } = await import('./db')
    const bookId = newBookId()
    const file: BookFile = {
      bookId,
      blob: new Blob(['hello world'], { type: 'text/plain' }),
      name: 'book.txt',
      type: 'text/plain',
      size: 11,
    }
    await putBookFile(file)
    const result = await getBookFile(bookId)
    expect(result?.name).toBe('book.txt')
    expect(result?.type).toBe('text/plain')
    expect(result?.size).toBe(11)
  })

  it('returns undefined for a missing file', async () => {
    const { getBookFile } = await import('./db')
    expect(await getBookFile(newBookId())).toBeUndefined()
  })
})

describe('library + progress (M5)', () => {
  it('getAllBooks returns books newest-first by updatedAt', async () => {
    const oldest = makeBook({ updatedAt: 1000 })
    const middle = makeBook({ updatedAt: 2000 })
    const newest = makeBook({ updatedAt: 3000 })
    await putBook(oldest)
    await putBook(middle)
    await putBook(newest)
    expect(await getAllBooks()).toEqual([newest, middle, oldest])
  })

  it('getAllBooks returns an empty array when no books exist', async () => {
    expect(await getAllBooks()).toEqual([])
  })

  it('a book stored without the new fields loads with them undefined', async () => {
    const book = makeBook({ title: 'Legacy' })
    await putBook(book)
    const loaded = await getBook(book.id)
    expect(loaded?.position).toBeUndefined()
    expect(loaded?.progressFraction).toBeUndefined()
  })

  it('updateBookProgress round-trips position + fraction and bumps updatedAt', async () => {
    const before = makeBook({ updatedAt: 1000 })
    await putBook(before)
    await updateBookProgress(before.id, { chapterIndex: 2, paragraphIndex: 5 }, 0.42)
    const after = await getBook(before.id)
    expect(after?.position).toEqual({ chapterIndex: 2, paragraphIndex: 5 })
    expect(after?.progressFraction).toBeCloseTo(0.42)
    expect(after?.updatedAt).toBeGreaterThan(1000)
  })

  it('updateBookProgress preserves the other book fields', async () => {
    const book = makeBook({ title: 'Keep Me', format: 'epub', chapterCount: 9 })
    await putBook(book)
    await updateBookProgress(book.id, { chapterIndex: 1, paragraphIndex: 1 }, 0.1)
    const after = await getBook(book.id)
    expect(after?.title).toBe('Keep Me')
    expect(after?.format).toBe('epub')
    expect(after?.chapterCount).toBe(9)
    expect(after?.createdAt).toBe(book.createdAt)
  })

  it('updateBookProgress is a no-op for a missing book', async () => {
    await expect(
      updateBookProgress(newBookId(), { chapterIndex: 0, paragraphIndex: 0 }, 0),
    ).resolves.toBeUndefined()
  })

  it('updateBookProcessing round-trips a processing record and bumps updatedAt', async () => {
    const book = makeBook({ updatedAt: 1000 })
    await putBook(book)
    const processing: AppliedProcessing = {
      appliedAt: 1234,
      transforms: ['cleanup', 'translate'],
      params: { translate: { target: 'es' } },
    }
    await updateBookProcessing(book.id, processing)
    const after = await getBook(book.id)
    expect(after?.processing).toEqual(processing)
    expect(after?.updatedAt).toBeGreaterThan(1000)
  })

  it('updateBookProcessing(undefined) clears the record', async () => {
    const book = makeBook()
    await putBook(book)
    await updateBookProcessing(book.id, {
      appliedAt: 1,
      transforms: ['cleanup'],
      params: {},
    })
    expect((await getBook(book.id))?.processing).toBeDefined()
    await updateBookProcessing(book.id, undefined)
    expect((await getBook(book.id))?.processing).toBeUndefined()
  })

  it('updateBookProcessing is a no-op for a missing book', async () => {
    await expect(updateBookProcessing(newBookId(), undefined)).resolves.toBeUndefined()
  })

  it('deleteBookCascade removes the book, its chapters, and its file', async () => {
    const target = makeBook()
    const other = makeBook()
    await putBook(target)
    await putBook(other)
    await putChapters([
      { id: newChapterId(), bookId: target.id, index: 0, title: 'T0', paragraphs: ['x'] },
      { id: newChapterId(), bookId: target.id, index: 1, title: 'T1', paragraphs: ['y'] },
      { id: newChapterId(), bookId: other.id, index: 0, title: 'O0', paragraphs: ['z'] },
    ])
    await putBookFile({
      bookId: target.id,
      blob: new Blob(['x'], { type: 'text/plain' }),
      name: 't.txt',
      type: 'text/plain',
      size: 1,
    })
    await deleteBookCascade(target.id)
    expect(await getBook(target.id)).toBeUndefined()
    expect(await getChaptersByBook(target.id)).toEqual([])
    expect(await getBookFile(target.id)).toBeUndefined()
    // sibling book untouched
    expect(await getBook(other.id)).toEqual(other)
    expect((await getChaptersByBook(other.id)).map((c) => c.title)).toEqual(['O0'])
  })
})
