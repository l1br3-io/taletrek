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

describe('useOutline — runWithPdfOutline (M10 Tier 1)', () => {
  it('applies the PDF outline when the parser produces multiple chapters', async () => {
    const book = makeBook({ format: 'pdf', chapterCount: 1 })
    await seedBook(book, [makeChapter(['old single-chapter body'])])

    vi.mocked(parseInWorker).mockResolvedValue(
      mockParseResult(
        [
          { title: 'Chapter 1', paragraphs: ['Body of chapter 1.'] },
          { title: 'Chapter 2', paragraphs: ['Body of chapter 2.'] },
        ],
        'My PDF',
      ),
    )

    const { result } = renderHook(() => useOutline())
    expect(result.current.state.type).toBe('idle')

    await act(async () => {
      await result.current.runWithPdfOutline(book.id)
    })

    expect(result.current.state.type).toBe('done')
    if (result.current.state.type !== 'done') throw new Error('expected done')
    expect(result.current.state.message).toMatch(/PDF outline applied — 2 chapters/)

    const stored = await getChaptersByBook(book.id)
    expect(stored).toHaveLength(2)
    expect(stored[0]?.title).toBe('Chapter 1')
    expect(stored[1]?.title).toBe('Chapter 2')

    const storedBook = await getBook(book.id)
    expect(storedBook?.chapterCount).toBe(2)
    expect(storedBook?.position).toEqual({ chapterIndex: 0, paragraphIndex: 0 })
  })

  it('reports "no embedded outline" when the parser produces a single chapter', async () => {
    const book = makeBook({ format: 'pdf' })
    await seedBook(book, [makeChapter(['unchanged'])])

    vi.mocked(parseInWorker).mockResolvedValue(
      mockParseResult([{ title: 'My PDF', paragraphs: ['just body, no outline'] }]),
    )

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.runWithPdfOutline(book.id)
    })

    expect(result.current.state.type).toBe('done')
    if (result.current.state.type !== 'done') throw new Error('expected done')
    expect(result.current.state.message).toMatch(/no embedded outline/i)

    const stored = await getChaptersByBook(book.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.paragraphs).toEqual(['unchanged'])
  })

  it('reaches error when the original file is evicted', async () => {
    const book = makeBook({ format: 'pdf' })
    await putBook(book)
    await putChapters([makeChapter(['body'])])

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.runWithPdfOutline(book.id)
    })

    expect(result.current.state.type).toBe('error')
    if (result.current.state.type === 'error') {
      expect(result.current.state.message).toMatch(/Original file/)
    }
  })
})

describe('useOutline — runWithAi flattens Tier-1 multi-chapter input (M10)', () => {
  it('feeds AI a flat paragraph list when parser produced multiple chapters', async () => {
    const book = makeBook({ format: 'pdf', chapterCount: 3 })
    await seedBook(book, [
      makeChapter(['stale'], { index: 0 }),
      makeChapter(['stale'], { index: 1, id: chapterId('ch-2') }),
      makeChapter(['stale'], { index: 2, id: chapterId('ch-3') }),
    ])

    vi.mocked(parseInWorker).mockResolvedValue(
      mockParseResult(
        [
          { title: 'Front Matter', paragraphs: ['intro paragraph'] },
          { title: 'Chapter 1', paragraphs: ['body one', 'body two'] },
          { title: 'Chapter 2', paragraphs: ['body three'] },
        ],
        'My PDF',
      ),
    )

    const detect = vi.fn(async (_paragraphs: string[]) => [
      { paragraphIndex: 1, title: 'Chapter 1' },
      { paragraphIndex: 3, title: 'Chapter 2' },
    ])

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.runWithAi(book.id, detect)
    })

    // detect received the flattened paragraph list (4 paragraphs total)
    expect(detect).toHaveBeenCalledTimes(1)
    expect(detect.mock.calls[0]?.[0]).toEqual([
      'intro paragraph',
      'body one',
      'body two',
      'body three',
    ])

    const stored = await getChaptersByBook(book.id)
    expect(stored.length).toBe(2)
    expect(stored[0]?.title).toBe('Chapter 1')
    expect(stored[1]?.title).toBe('Chapter 2')
  })

  it('reports "no chapter headings" when AI returns empty', async () => {
    const book = makeBook()
    await seedBook(book, [makeChapter(['just body'])])

    vi.mocked(parseInWorker).mockResolvedValue(
      mockParseResult([{ title: 'Test', paragraphs: ['just body'] }]),
    )

    const detect = vi.fn(async () => [])
    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.runWithAi(book.id, detect)
    })

    expect(result.current.state.type).toBe('done')
    if (result.current.state.type !== 'done') throw new Error('expected done')
    expect(result.current.state.message).toMatch(/AI found no chapter headings/i)
  })

  it('reaches error when parseInWorker throws', async () => {
    const book = makeBook()
    await seedBook(book, [makeChapter(['body'])])

    vi.mocked(parseInWorker).mockRejectedValue(new Error('Worker exploded'))

    const { result } = renderHook(() => useOutline())
    await act(async () => {
      await result.current.runWithAi(book.id, vi.fn())
    })

    expect(result.current.state.type).toBe('error')
    if (result.current.state.type === 'error') {
      expect(result.current.state.message).toMatch(/Worker exploded/)
    }
  })
})

describe('useOutline — re-entrancy guard', () => {
  it('ignores a second runWithPdfOutline call while one is in flight', async () => {
    const book = makeBook({ format: 'pdf' })
    await seedBook(book, [makeChapter(['body'])])

    let resolveParse: (() => void) | null = null
    vi.mocked(parseInWorker).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveParse = () =>
            resolve(
              mockParseResult([
                { title: 'C1', paragraphs: ['x'] },
                { title: 'C2', paragraphs: ['y'] },
              ]),
            )
        }),
    )

    const { result } = renderHook(() => useOutline())
    let firstRun!: Promise<boolean>
    act(() => {
      firstRun = result.current.runWithPdfOutline(book.id)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.state.type).toBe('running')

    await act(async () => {
      await result.current.runWithPdfOutline(book.id)
    })

    await act(async () => {
      resolveParse?.()
      await firstRun
    })

    expect(result.current.state.type).toBe('done')
    expect(vi.mocked(parseInWorker)).toHaveBeenCalledTimes(1)
  })
})
