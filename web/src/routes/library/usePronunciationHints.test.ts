import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiTransformEngine, PronunciationCandidate } from '../../lib/ai/types'
import { _clearDBForTests, _resetDBForTests, putChapters } from '../../lib/db'
import { type BookId, bookId, chapterId } from '../../types'
import { usePronunciationHints } from './usePronunciationHints'

function stubEngine(
  candidates: PronunciationCandidate[],
  opts: { failWith?: Error } = {},
): AiTransformEngine {
  return {
    isReady: () => Promise.resolve(true),
    transform: vi.fn(async (input: string[]) => input),
    proposePronunciationHints: vi.fn(async () => {
      if (opts.failWith) throw opts.failWith
      return candidates
    }),
    detectOutline: vi.fn(async () => []),
  }
}

const BOOK: BookId = bookId('book-1')

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  await putChapters([
    {
      id: chapterId('c1'),
      bookId: BOOK,
      index: 0,
      title: 'C0',
      paragraphs: ['Siobhan went to Dnipropetrovsk.'],
    },
  ])
})

describe('usePronunciationHints', () => {
  it('scans the first chapter and reaches ready with candidates', async () => {
    const candidates: PronunciationCandidate[] = [
      { id: '1', find: 'Siobhan', replace: 'Shi-vawn', confidence: 0.9, category: 'proper-noun' },
    ]
    const { result } = renderHook(() => usePronunciationHints(stubEngine(candidates)))
    expect(result.current.state.type).toBe('idle')

    await act(async () => {
      await result.current.scan(BOOK)
    })
    expect(result.current.state.type).toBe('ready')
    if (result.current.state.type === 'ready') {
      expect(result.current.state.candidates).toEqual(candidates)
    }
  })

  it('reaches error when the engine throws', async () => {
    const { result } = renderHook(() =>
      usePronunciationHints(stubEngine([], { failWith: new Error('model offline') })),
    )
    await act(async () => {
      await result.current.scan(BOOK)
    })
    expect(result.current.state.type).toBe('error')
    if (result.current.state.type === 'error') {
      expect(result.current.state.message).toMatch(/model offline/)
    }
  })

  it('errors when no engine is configured (AI disabled)', async () => {
    const { result } = renderHook(() => usePronunciationHints(null))
    await act(async () => {
      await result.current.scan(BOOK)
    })
    expect(result.current.state.type).toBe('error')
  })

  it('reset returns to idle', async () => {
    const { result } = renderHook(() => usePronunciationHints(stubEngine([])))
    await act(async () => {
      await result.current.scan(BOOK)
    })
    expect(result.current.state.type).toBe('ready')
    act(() => result.current.reset())
    expect(result.current.state.type).toBe('idle')
  })

  it('returns empty candidates when the first chapter is empty', async () => {
    await putChapters([
      { id: chapterId('c1'), bookId: BOOK, index: 0, title: 'C0', paragraphs: [] },
    ])
    const { result } = renderHook(() => usePronunciationHints(stubEngine([])))
    await act(async () => {
      await result.current.scan(BOOK)
    })
    expect(result.current.state.type).toBe('ready')
    if (result.current.state.type === 'ready') {
      expect(result.current.state.candidates).toEqual([])
    }
  })

  it('handles an empty chapter list gracefully', async () => {
    await putChapters([])
    const { result } = renderHook(() => usePronunciationHints(stubEngine([])))
    await act(async () => {
      await result.current.scan(BOOK)
    })
    expect(result.current.state.type).toBe('ready')
  })
})
