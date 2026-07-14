import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _clearDBForTests,
  _resetDBForTests,
  getBook,
  getChaptersByBook,
  putBook,
  putBookFile,
  putChapters,
} from '../../lib/db'
import type { ParseResult } from '../../lib/parse/types'
import { type Book, bookId, type Chapter, chapterId } from '../../types'
import { useOutline } from './useOutline'

vi.mock('../../lib/parse/client', () => ({
  parseInWorker: vi.fn(),
}))

const { parseInWorker } = await import('../../lib/parse/client')

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: bookId('book-1'),
    title: 'Test',
    format: 'txt',
    chapterCount: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeChapter(paragraphs: string[], overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: chapterId('ch-1'),
    bookId: bookId('book-1'),
    index: 0,
    title: 'Test',
    paragraphs,
    ...overrides,
  }
}

function mockParseResult(
  chapters: { title: string; paragraphs: string[] }[],
  title = 'Test',
): ParseResult {
  return { title, chapters }
}

async function seedBook(book: Book, chapters: Chapter[], fileContent = 'raw'): Promise<void> {
  await putBook(book)
  await putChapters(chapters)
  await putBookFile({
    bookId: book.id,
    blob: new Blob([fileContent]),
    name: 'test.txt',
    type: 'text/plain',
    size: fileContent.length,
  })
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  vi.mocked(parseInWorker).mockReset()
})

describe('useOutline — happy path', () => {
  it('re-parses, detects headings, writes new chapters, resets position', async () => {
    const book = makeBook({ position: { chapterIndex: 0, paragraphIndex: 5 } })
    await seedBook(book, [makeChapter(['stale paragraph'])])

    vi.mocked(parseInWorker).mockResolvedValue(
      mockParseResult([
        {
          title: 'Test',
          paragraphs: ['Chapter 1', 'Hello world.', 'Chapter 2', 'Goodbye.'],
        },
      ]),
    )

    const { result } = renderHook(() => useOutline())
    expect(result.current.state.type).toBe('idle')

    await act(async () => {
      await result.current.run(book.id)
    })

    expect(result.current.state.type).toBe('done')
    if (result.current.state.type !== 'done') throw new Error('expected done')
    expect(result.current.state.message).toMatch(/2 chapters detected/)

    const stored = await getChaptersByBook(book.id)
    expect(stored).toHaveLength(2)
    expect(stored[0]?.title).toBe('Chapter 1')
    expect(stored[0]?.paragraphs).toEqual(['Hello world.'])
    expect(stored[1]?.title).toBe('Chapter 2')
    expect(stored[1]?.paragraphs).toEqual(['Goodbye.'])

    const storedBook = await getBook(book.id)
    expect(storedBook?.chapterCount).toBe(2)
    expect(storedBook?.position).toEqual({ chapterIndex: 0, paragraphIndex: 0 })
    expect(storedBook?.progressFraction).toBe(0)
  })

  it('assigns fresh chapter IDs (old IDs are gone)', async () => {
    const book = makeBook()
    const oldChapter = makeChapter(['old'])
    await seedBook(book, [oldChapter])

    vi.mocked(parseInWorker).mockResolvedValue(
      mockParseResult([{ title: 'Test', paragraphs: ['Chapter 1', 'Body.'] }]),
    )

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.run(book.id)
    })

    const stored = await getChaptersByBook(book.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.id).not.toBe(oldChapter.id)
  })
})

describe('useOutline — no detection', () => {
  it('reports done with "no headings" when none are found, leaves chapters unchanged', async () => {
    const book = makeBook()
    const original = makeChapter(['Just some body text without headings.'])
    await seedBook(book, [original])

    vi.mocked(parseInWorker).mockResolvedValue(
      mockParseResult([{ title: 'Test', paragraphs: ['Just some body text without headings.'] }]),
    )

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.run(book.id)
    })

    expect(result.current.state.type).toBe('done')
    if (result.current.state.type !== 'done') throw new Error('expected done')
    expect(result.current.state.message).toMatch(/No chapter headings/)

    const stored = await getChaptersByBook(book.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.id).toBe(original.id)
    expect(stored[0]?.paragraphs).toEqual(['Just some body text without headings.'])
  })

  it('does not detect when the parse already yields multiple chapters (EPUB)', async () => {
    const book = makeBook({ format: 'epub', chapterCount: 2 })
    await seedBook(book, [
      makeChapter(['Body 1.'], { index: 0 }),
      makeChapter(['Body 2.'], { index: 1, id: chapterId('ch-2') }),
    ])

    vi.mocked(parseInWorker).mockResolvedValue(
      mockParseResult([
        { title: 'Chapter 1', paragraphs: ['Body 1.'] },
        { title: 'Chapter 2', paragraphs: ['Body 2.'] },
      ]),
    )

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.run(book.id)
    })

    expect(result.current.state.type).toBe('done')
    if (result.current.state.type !== 'done') throw new Error('expected done')
    expect(result.current.state.message).toMatch(/No chapter headings/)
  })
})

describe('useOutline — errors', () => {
  it('reaches error when the original file is evicted', async () => {
    const book = makeBook()
    await putBook(book)
    await putChapters([makeChapter(['body'])])
    // No putBookFile — file is missing

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.run(book.id)
    })

    expect(result.current.state.type).toBe('error')
    if (result.current.state.type === 'error') {
      expect(result.current.state.message).toMatch(/Original file/)
    }
  })

  it('reaches error when parseInWorker throws', async () => {
    const book = makeBook()
    await seedBook(book, [makeChapter(['body'])])

    vi.mocked(parseInWorker).mockRejectedValue(new Error('Worker exploded'))

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.run(book.id)
    })

    expect(result.current.state.type).toBe('error')
    if (result.current.state.type === 'error') {
      expect(result.current.state.message).toMatch(/Worker exploded/)
    }
  })
})

describe('useOutline — re-entrancy guard', () => {
  it('ignores a second run call while one is in flight', async () => {
    const book = makeBook()
    await seedBook(book, [makeChapter(['body'])])

    let resolveParse: (() => void) | null = null
    vi.mocked(parseInWorker).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveParse = () =>
            resolve(mockParseResult([{ title: 'T', paragraphs: ['Chapter 1', 'x'] }]))
        }),
    )

    const { result } = renderHook(() => useOutline())
    let firstRun!: Promise<boolean>
    act(() => {
      firstRun = result.current.run(book.id)
    })
    // Wait for running state
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.state.type).toBe('running')

    // Second call should be a no-op
    await act(async () => {
      await result.current.run(book.id)
    })

    // Resolve the first run
    await act(async () => {
      resolveParse?.()
      await firstRun
    })

    expect(result.current.state.type).toBe('done')
    expect(vi.mocked(parseInWorker)).toHaveBeenCalledTimes(1)
  })
})
