import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatasourceProvider } from '../../context/datasource'
import type {
  AiTransformEngine,
  PronunciationCandidate,
  TransformDefinition,
  TransformOp,
} from '../../lib/ai/types'
import { transformDefId } from '../../lib/ai/types'
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

// Mock getAiEngineForDef — factory must NOT reference top-level variables
// since vi.mock is hoisted. Use vi.fn() directly in the factory.
vi.mock('../../lib/ai/client', () => ({
  getAiEngineForDef: vi.fn(),
}))

import { getAiEngineForDef } from '../../lib/ai/client'

/** renderHook with the (default-local) DatasourceProvider mounted. */
function renderHookWithDs<T>(fn: () => T) {
  return renderHook(fn, { wrapper: DatasourceProvider })
}

const mockGetEngine = vi.mocked(getAiEngineForDef)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDef(overrides: Partial<TransformDefinition> = {}): TransformDefinition {
  return {
    id: transformDefId('test-cleanup'),
    label: 'Clean up',
    hint: 'Remove clutter',
    desc: 'Cleans up source text',
    systemPrompt: 'Clean up: {{text}}',
    params: [],
    ...overrides,
  }
}

const def1 = makeDef({ id: transformDefId('def1'), label: 'Clean up' })
const def2 = makeDef({
  id: transformDefId('def2'),
  label: 'Translate',
  params: [{ key: 'target', type: 'text' as const, label: 'Target', default: 'es' }],
})

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

/** Stub engine: prefixes each paragraph with the def label, reports 0..1 progress. */
function stubEngine(opts: { failWith?: Error } = {}): AiTransformEngine {
  return {
    isReady: () => Promise.resolve(true),
    transform: vi.fn(
      async (
        input: string[],
        _op: TransformOp,
        def: TransformDefinition,
        onProgress?: (f: number) => void,
      ) => {
        if (opts.failWith) throw opts.failWith
        onProgress?.(0.5)
        onProgress?.(1)
        return input.map((p) => `${def.label}:${p}`)
      },
    ),
    proposePronunciationHints: vi.fn(async (): Promise<PronunciationCandidate[]> => []),
    detectOutline: vi.fn(async () => []),
  }
}

function makeAiSettings(enabled = true) {
  return {
    enabled,
    backend: 'cloud' as const,
    cloud: { providers: [], activeProviderId: null },
    transformDefs: [def1, def2],
  }
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  mockGetEngine.mockReset()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAiTransform — happy path', () => {
  it('runs cleanup, writes chapters + processing, resets position, reaches done', async () => {
    const book = makeBook({ position: { chapterIndex: 2, paragraphIndex: 7 } })
    const chapter = makeChapter(['hello', 'world'])
    await putBook(book)
    await putChapters([chapter])

    mockGetEngine.mockReturnValue(stubEngine())
    const { result } = renderHookWithDs(() =>
      useAiTransform({ ai: makeAiSettings(), defs: [def1] }),
    )
    expect(result.current.state.type).toBe('idle')

    await act(async () => {
      await result.current.run({ book, chapters: [chapter], ops: [{ defId: def1.id, params: {} }] })
    })

    expect(result.current.state.type).toBe('done')
    if (result.current.state.type !== 'done') throw new Error('expected done')

    const stored = await getChaptersByBook(book.id)
    expect(stored[0]?.paragraphs).toEqual(['Clean up:hello', 'Clean up:world'])
    const storedBook = await getBook(book.id)
    expect(storedBook?.processing?.ops).toEqual([{ defId: def1.id, params: {} }])
    expect(storedBook?.position).toEqual({ chapterIndex: 2, paragraphIndex: 0 })
    expect(storedBook?.progressFraction).toBe(0)
    expect(result.current.state.message).toBe('Transform applied — resumed at start of chapter 3.')
  })

  it('chains multiple ops (cleanup output feeds translate)', async () => {
    const book = makeBook()
    const chapter = makeChapter(['p'])
    await putBook(book)
    await putChapters([chapter])

    mockGetEngine.mockReturnValue(stubEngine())
    const { result } = renderHookWithDs(() =>
      useAiTransform({ ai: makeAiSettings(), defs: [def1, def2] }),
    )
    await act(async () => {
      await result.current.run({
        book,
        chapters: [chapter],
        ops: [
          { defId: def1.id, params: {} },
          { defId: def2.id, params: { target: 'es' } },
        ],
      })
    })

    expect(result.current.state.type).toBe('done')
    const stored = await getChaptersByBook(book.id)
    // def1 ("Clean up") runs first, then def2 ("Translate") runs on the output
    expect(stored[0]?.paragraphs).toEqual(['Translate:Clean up:p'])
    const storedBook = await getBook(book.id)
    expect(storedBook?.processing?.ops).toEqual([
      { defId: def1.id, params: {} },
      { defId: def2.id, params: { target: 'es' } },
    ])
  })
})

describe('useAiTransform — prepare + state edge cases', () => {
  it('runs prepare before transforms and reports its progress', async () => {
    const book = makeBook()
    const chapter = makeChapter(['a'])
    await putBook(book)
    await putChapters([chapter])

    mockGetEngine.mockReturnValue(stubEngine())
    const prepare = vi.fn(async (onProgress: (f: number) => void) => {
      onProgress(0.5)
      onProgress(1)
    })
    const { result } = renderHookWithDs(() =>
      useAiTransform({ ai: makeAiSettings(), defs: [def1], prepare }),
    )
    await act(async () => {
      await result.current.run({ book, chapters: [chapter], ops: [{ defId: def1.id, params: {} }] })
    })
    expect(prepare).toHaveBeenCalled()
    expect(result.current.state.type).toBe('done')
  })

  it('reaches error when prepare throws', async () => {
    mockGetEngine.mockReturnValue(stubEngine())
    const { result } = renderHookWithDs(() =>
      useAiTransform({
        ai: makeAiSettings(),
        defs: [def1],
        prepare: async () => {
          throw new Error('WebGPU unavailable')
        },
      }),
    )
    await act(async () => {
      await result.current.run({
        book: makeBook(),
        chapters: [makeChapter(['a'])],
        ops: [{ defId: def1.id, params: {} }],
      })
    })
    expect(result.current.state.type).toBe('error')
  })

  it('stays idle when no ops are given', async () => {
    mockGetEngine.mockReturnValue(stubEngine())
    const { result } = renderHookWithDs(() =>
      useAiTransform({ ai: makeAiSettings(), defs: [def1] }),
    )
    await act(async () => {
      await result.current.run({ book: makeBook(), chapters: [], ops: [] })
    })
    expect(result.current.state.type).toBe('idle')
  })

  it('errors when AI is not enabled', async () => {
    const { result } = renderHookWithDs(() => useAiTransform({ ai: undefined, defs: [] }))
    await act(async () => {
      await result.current.run({
        book: makeBook(),
        chapters: [makeChapter(['a'])],
        ops: [{ defId: def1.id, params: {} }],
      })
    })
    expect(result.current.state.type).toBe('error')
  })

  it('reaches error on a non-abort transform failure', async () => {
    mockGetEngine.mockReturnValue(stubEngine({ failWith: new Error('model exploded') }))
    const { result } = renderHookWithDs(() =>
      useAiTransform({ ai: makeAiSettings(), defs: [def1] }),
    )
    await act(async () => {
      await result.current.run({
        book: makeBook(),
        chapters: [makeChapter(['a'])],
        ops: [{ defId: def1.id, params: {} }],
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

    mockGetEngine.mockReturnValue(stubEngine())
    const { result } = renderHookWithDs(() =>
      useAiTransform({ ai: makeAiSettings(), defs: [def1] }),
    )
    await act(async () => {
      await result.current.run({ book, resolveChapters, ops: [{ defId: def1.id, params: {} }] })
    })

    expect(resolveChapters).toHaveBeenCalledTimes(1)
    expect(result.current.state.type).toBe('done')
    const stored = await getChaptersByBook(book.id)
    expect(stored[0]?.paragraphs).toEqual(['Clean up:original-a', 'Clean up:original-b'])
  })

  it('reaches error when resolveChapters throws (e.g. original file evicted)', async () => {
    const book = makeBook()
    await putBook(book)

    mockGetEngine.mockReturnValue(stubEngine())
    const resolveChapters = vi.fn(async () => {
      throw new Error('Original file is no longer available')
    })
    const { result } = renderHookWithDs(() =>
      useAiTransform({ ai: makeAiSettings(), defs: [def1] }),
    )
    await act(async () => {
      await result.current.run({ book, resolveChapters, ops: [{ defId: def1.id, params: {} }] })
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
          _def: TransformDefinition,
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

    mockGetEngine.mockReturnValue(engine)
    const { result } = renderHookWithDs(() =>
      useAiTransform({ ai: makeAiSettings(), defs: [def1] }),
    )
    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run({
        book,
        chapters: [chapter],
        ops: [{ defId: def1.id, params: {} }],
      })
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
