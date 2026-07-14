import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiTransformEngine, PronunciationCandidate, TransformOp } from '../../lib/ai/types'
import {
  _clearDBForTests,
  _resetDBForTests,
  getBook,
  getChaptersByBook,
  putBook,
  putChapters,
} from '../../lib/db'
import { type Book, bookId, type Chapter, chapterId } from '../../types'
import { useAiTransform } from './useAiTransform'

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
    title: 'C0',
    paragraphs,
    ...overrides,
  }
}

/** Stub engine: prefixes each paragraph with the op kind, reports 0..1 progress. */
function stubEngine(opts: { failWith?: Error } = {}): AiTransformEngine {
  return {
    isReady: () => Promise.resolve(true),
    transform: vi.fn(async (input: string[], op: TransformOp, onProgress?: (f: number) => void) => {
      if (opts.failWith) throw opts.failWith
      onProgress?.(0.5)
      onProgress?.(1)
      return input.map((p) => `${op.kind}:${p}`)
    }),
    proposePronunciationHints: vi.fn(async (): Promise<PronunciationCandidate[]> => []),
    detectOutline: vi.fn(async () => []),
  }
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('useAiTransform — happy path', () => {
  it('runs cleanup, writes chapters + processing, resets position, reaches done', async () => {
    const book = makeBook({ position: { chapterIndex: 2, paragraphIndex: 7 } })
    const chapter = makeChapter(['hello', 'world'])
    await putBook(book)
    await putChapters([chapter])

    const { result } = renderHook(() => useAiTransform({ engine: stubEngine() }))
    expect(result.current.state.type).toBe('idle')

    await act(async () => {
      await result.current.run({ book, chapters: [chapter], ops: [{ kind: 'cleanup' }] })
    })

    expect(result.current.state.type).toBe('done')
    if (result.current.state.type !== 'done') throw new Error('expected done')

    const stored = await getChaptersByBook(book.id)
    expect(stored[0]?.paragraphs).toEqual(['cleanup:hello', 'cleanup:world'])
    const storedBook = await getBook(book.id)
    expect(storedBook?.processing?.transforms).toEqual(['cleanup'])
    expect(storedBook?.position).toEqual({ chapterIndex: 2, paragraphIndex: 0 })
    expect(storedBook?.progressFraction).toBe(0)
    expect(result.current.state.message).toBe('Transform applied — resumed at start of chapter 3.')
  })

  it('chains multiple ops (cleanup output feeds translate)', async () => {
    const book = makeBook()
    const chapter = makeChapter(['p'])
    await putBook(book)
    await putChapters([chapter])

    const { result } = renderHook(() => useAiTransform({ engine: stubEngine() }))
    await act(async () => {
      await result.current.run({
        book,
        chapters: [chapter],
        ops: [{ kind: 'cleanup' }, { kind: 'translate', target: 'es' }],
      })
    })

    expect(result.current.state.type).toBe('done')
    const stored = await getChaptersByBook(book.id)
    expect(stored[0]?.paragraphs).toEqual(['translate:cleanup:p'])
    const storedBook = await getBook(book.id)
    expect(storedBook?.processing?.transforms).toEqual(['cleanup', 'translate'])
    expect(storedBook?.processing?.params.translate).toEqual({ target: 'es' })
  })
})

describe('useAiTransform — prepare + state edge cases', () => {
  it('runs prepare before transforms and reports its progress', async () => {
    const book = makeBook()
    const chapter = makeChapter(['a'])
    await putBook(book)
    await putChapters([chapter])

    const prepare = vi.fn(async (onProgress: (f: number) => void) => {
      onProgress(0.5)
      onProgress(1)
    })
    const { result } = renderHook(() => useAiTransform({ engine: stubEngine(), prepare }))
    await act(async () => {
      await result.current.run({ book, chapters: [chapter], ops: [{ kind: 'cleanup' }] })
    })
    expect(prepare).toHaveBeenCalled()
    expect(result.current.state.type).toBe('done')
  })

  it('reaches error when prepare throws (e.g. WebGPU unavailable)', async () => {
    const { result } = renderHook(() =>
      useAiTransform({
        engine: stubEngine(),
        prepare: async () => {
          throw new Error('WebGPU unavailable')
        },
      }),
    )
    await act(async () => {
      await result.current.run({
        book: makeBook(),
        chapters: [makeChapter(['a'])],
        ops: [{ kind: 'cleanup' }],
      })
    })
    expect(result.current.state.type).toBe('error')
  })

  it('stays idle when no ops are given', async () => {
    const { result } = renderHook(() => useAiTransform({ engine: stubEngine() }))
    await act(async () => {
      await result.current.run({ book: makeBook(), chapters: [], ops: [] })
    })
    expect(result.current.state.type).toBe('idle')
  })

  it('errors when no engine is configured (AI disabled)', async () => {
    const { result } = renderHook(() => useAiTransform({ engine: null }))
    await act(async () => {
      await result.current.run({
        book: makeBook(),
        chapters: [makeChapter(['a'])],
        ops: [{ kind: 'cleanup' }],
      })
    })
    expect(result.current.state.type).toBe('error')
  })

  it('reaches error on a non-abort transform failure', async () => {
    const { result } = renderHook(() =>
      useAiTransform({ engine: stubEngine({ failWith: new Error('model exploded') }) }),
    )
    await act(async () => {
      await result.current.run({
        book: makeBook(),
        chapters: [makeChapter(['a'])],
        ops: [{ kind: 'cleanup' }],
      })
    })
    expect(result.current.state.type).toBe('error')
    if (result.current.state.type === 'error') {
      expect(result.current.state.message).toMatch(/model exploded/)
    }
  })
})

describe('useAiTransform — resolveChapters (reprocess)', () => {
  it('re-parses via resolveChapters before transforming, and writes the result', async () => {
    const book = makeBook()
    await putBook(book)
    // Existing (stale/processed) chapter in the DB — should be overwritten by the run.
    await putChapters([makeChapter(['stale'])])

    const fresh = makeChapter(['original-a', 'original-b'])
    const resolveChapters = vi.fn(async () => [fresh])

    const { result } = renderHook(() => useAiTransform({ engine: stubEngine() }))
    await act(async () => {
      await result.current.run({ book, resolveChapters, ops: [{ kind: 'cleanup' }] })
    })

    expect(resolveChapters).toHaveBeenCalledTimes(1)
    expect(result.current.state.type).toBe('done')
    const stored = await getChaptersByBook(book.id)
    expect(stored[0]?.paragraphs).toEqual(['cleanup:original-a', 'cleanup:original-b'])
  })

  it('reaches error when resolveChapters throws (e.g. original file evicted)', async () => {
    const book = makeBook()
    await putBook(book)

    const resolveChapters = vi.fn(async () => {
      throw new Error('Original file is no longer available')
    })
    const { result } = renderHook(() => useAiTransform({ engine: stubEngine() }))
    await act(async () => {
      await result.current.run({ book, resolveChapters, ops: [{ kind: 'cleanup' }] })
    })
    expect(result.current.state.type).toBe('error')
    if (result.current.state.type === 'error') {
      expect(result.current.state.message).toMatch(/Original file/)
    }
  })
})

describe('useAiTransform — abort', () => {
  it('aborts an in-flight run and returns to idle', async () => {
    const book = makeBook()
    const chapter = makeChapter(['a'])
    await putBook(book)
    await putChapters([chapter])

    const gate: { current: (() => void) | null } = { current: null }
    const blocked = new Promise<void>((resolve) => {
      gate.current = resolve
    })
    const engine: AiTransformEngine = {
      isReady: () => Promise.resolve(true),
      transform: vi.fn(
        async (
          _input: string[],
          _op: TransformOp,
          _onProgress?: (f: number) => void,
          signal?: AbortSignal,
        ) => {
          await blocked
          if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
          return ['x']
        },
      ),
      proposePronunciationHints: vi.fn(async () => []),
      detectOutline: vi.fn(async () => []),
    }

    const { result } = renderHook(() => useAiTransform({ engine }))
    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run({ book, chapters: [chapter], ops: [{ kind: 'cleanup' }] })
    })
    await waitFor(() => expect(result.current.state.type).toBe('running'))

    act(() => result.current.abort())
    act(() => gate.current?.())

    await act(async () => {
      await runPromise
    })
    expect(result.current.state.type).toBe('idle')
  })
})
