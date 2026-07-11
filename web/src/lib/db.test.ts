import { beforeEach, describe, expect, it } from 'vitest'
import { type Book, type BookFile, type Chapter, newBookId, newChapterId } from '../types'
import { _clearDBForTests, _resetDBForTests, deleteSetting, getSetting, setSetting } from './db'

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
