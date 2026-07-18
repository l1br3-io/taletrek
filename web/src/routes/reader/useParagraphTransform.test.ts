import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiTransformEngine, TransformDefinition } from '../../lib/ai/types'
import { transformDefId } from '../../lib/ai/types'
import type { Chapter, ChapterId } from '../../types'
import { useParagraphTransform } from './useParagraphTransform'

// Mock getAiEngineForDef — factory must NOT reference top-level variables.
vi.mock('../../lib/ai/client', () => ({
  getAiEngineForDef: vi.fn(),
}))

import { getAiEngineForDef } from '../../lib/ai/client'

const mockGetEngine = vi.mocked(getAiEngineForDef)

// Mock ttsClient.synthesize so it doesn't kick off real work during commit.
vi.mock('../../lib/tts/client', () => ({
  ttsClient: { synthesize: vi.fn().mockResolvedValue(new ArrayBuffer(0)) },
}))

function makeDef(): TransformDefinition {
  return {
    id: transformDefId('simplify'),
    label: 'Simplify',
    hint: '',
    desc: '',
    systemPrompt: 'Simplify: {{level}}',
    params: [{ key: 'level', type: 'range', label: 'Level', default: 2 }],
  }
}

const CHAPTER_ID = 'c1' as ChapterId
const PARA_ID = 'c1:0'

function makeChapter(text: string = 'Original paragraph text.'): Chapter {
  return {
    id: CHAPTER_ID,
    bookId: 'b1' as never,
    index: 0,
    title: 'Ch1',
    paragraphs: [text],
  }
}

function renderTF(overrides: Partial<Parameters<typeof useParagraphTransform>[0]> = {}) {
  return renderHook(() =>
    useParagraphTransform({
      currentParagraphId: PARA_ID,
      chapters: [makeChapter()],
      cleanedParagraphs: [
        {
          id: PARA_ID,
          chapterId: CHAPTER_ID,
          chapterIndex: 0,
          paragraphIndex: 0,
          text: 'Original paragraph text.',
        },
      ],
      cleaning: {
        enabled: true,
        filters: {
          urls: false,
          images: false,
          footnotes: false,
          pageNumbers: false,
        },
        pronunciation: [],
      },
      ai: {
        enabled: true,
        backend: 'cloud',
        cloud: { providers: [], activeProviderId: null },
        transformDefs: [makeDef()],
      },
      synthMode: 'off',
      voiceId: 'voice-1' as never,
      online: true,
      bookId: 'b1' as never,
      onParagraphChanged: vi.fn(),
      onPause: vi.fn(),
      ...overrides,
    }),
  )
}

function makeEngine(streamBehavior: {
  /** Resolve the transform promise with this string. */
  resolveWith: string
  /** Emit these deltas (in order) via onDelta before resolving. */
  emitDeltas?: string[]
  /** Delay between emit + resolve (ms). Default 0. */
  delayMs?: number
  /** Throw instead of resolving. */
  throwErr?: Error
}): AiTransformEngine {
  return {
    isReady: vi.fn().mockResolvedValue(true),
    transform: vi.fn(
      async (
        _input: string[],
        _op: never,
        _def: never,
        _onProgress?: never,
        _signal?: AbortSignal,
        onDelta?: (textSoFar: string, delta: string) => void,
      ): Promise<string[]> => {
        const { emitDeltas = [], resolveWith, delayMs = 0, throwErr } = streamBehavior
        let acc = ''
        for (const d of emitDeltas) {
          acc += d
          onDelta?.(acc, d)
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        if (throwErr) throw throwErr
        return [resolveWith]
      },
    ),
    proposePronunciationHints: vi.fn(),
    detectOutline: vi.fn(),
  }
}

beforeEach(() => {
  mockGetEngine.mockReset()
})

describe('useParagraphTransform — streaming', () => {
  it('surfaces streamed deltas via the `stream` field', async () => {
    // Deferred promise so the test can observe the intermediate streaming
    // state before the engine resolves. An immediately-resolving engine would
    // set + clear `stream` within a single microtask, racing the assertion.
    let resolveTransform!: (val: string[]) => void
    const engine: AiTransformEngine = {
      isReady: vi.fn().mockResolvedValue(true),
      transform: vi.fn(
        async (
          _input: string[],
          _op: never,
          _def: never,
          _onProgress?: never,
          _signal?: AbortSignal,
          onDelta?: (textSoFar: string, delta: string) => void,
        ): Promise<string[]> => {
          onDelta?.('Hello', 'Hello')
          onDelta?.('Hello, ', ', ')
          onDelta?.('Hello, world!', 'world!')
          return new Promise<string[]>((resolve) => {
            resolveTransform = resolve
          })
        },
      ),
      proposePronunciationHints: vi.fn(),
      detectOutline: vi.fn(),
    }
    mockGetEngine.mockReturnValue(engine)

    const { result } = renderTF()

    act(() => {
      void result.current.applyAi({ defId: transformDefId('simplify'), params: {} })
    })

    await waitFor(() => expect(result.current.stream).not.toBeNull())
    expect(result.current.stream?.paragraphId).toBe(PARA_ID)
    expect(result.current.stream?.opLabel).toBe('Simplify')
    await waitFor(() => expect(result.current.stream?.streamingText).toBe('Hello, world!'))
    expect(result.current.aiBusy).toBe(true)

    // Release the engine — hook commits + clears stream state.
    await act(async () => resolveTransform(['Hello, world!']))

    await waitFor(() => expect(result.current.stream).toBeNull())
    expect(result.current.aiBusy).toBe(false)
  })

  it('closes the modal when an AI op is applied (streaming happens in-place)', async () => {
    const engine = makeEngine({ resolveWith: 'Cleaned.' })
    mockGetEngine.mockReturnValue(engine)
    const { result } = renderTF()

    act(() => result.current.setTransformOpen(true))
    expect(result.current.transformOpen).toBe(true)

    await act(async () => {
      await result.current.applyAi({ defId: transformDefId('simplify'), params: {} })
    })
    expect(result.current.transformOpen).toBe(false)
  })

  it('stopAi aborts the in-flight stream and clears stream state (no commit)', async () => {
    // Engine that hangs until aborted.
    let abortSignal: AbortSignal | undefined
    const engine: AiTransformEngine = {
      isReady: vi.fn().mockResolvedValue(true),
      transform: vi.fn(
        async (
          _input: string[],
          _op: never,
          _def: never,
          _onProgress?: never,
          signal?: AbortSignal,
          onDelta?: (textSoFar: string, delta: string) => void,
        ): Promise<string[]> => {
          abortSignal = signal
          onDelta?.('Partial', 'Partial')
          return new Promise<string[]>((_, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'))
            })
          })
        },
      ),
      proposePronunciationHints: vi.fn(),
      detectOutline: vi.fn(),
    }
    mockGetEngine.mockReturnValue(engine)

    const onParagraphChanged = vi.fn()
    const { result } = renderTF({ onParagraphChanged })

    act(() => {
      void result.current.applyAi({ defId: transformDefId('simplify'), params: {} })
    })
    await waitFor(() => expect(result.current.stream?.streamingText).toBe('Partial'))

    act(() => result.current.stopAi())
    await waitFor(() => expect(result.current.stream).toBeNull())
    expect(result.current.aiBusy).toBe(false)
    expect(abortSignal?.aborted).toBe(true)
    // No commit fired — undo stack empty.
    expect(result.current.undoCount).toBe(0)
    expect(onParagraphChanged).not.toHaveBeenCalled()
    // No error surfaced — abort is silent recovery.
    expect(result.current.transformError).toBeNull()
  })

  it('commits the final result and pushes undo stack on success', async () => {
    const engine = makeEngine({ resolveWith: 'Simplified.' })
    mockGetEngine.mockReturnValue(engine)

    const { result } = renderTF()

    await act(async () => {
      await result.current.applyAi({ defId: transformDefId('simplify'), params: {} })
    })
    expect(result.current.stream).toBeNull()
    expect(result.current.undoCount).toBe(1)
  })

  it('surfaces error when AI returns empty result', async () => {
    const engine = makeEngine({ resolveWith: '   ' })
    mockGetEngine.mockReturnValue(engine)
    const { result } = renderTF()

    await act(async () => {
      await result.current.applyAi({ defId: transformDefId('simplify'), params: {} })
    })
    expect(result.current.transformError).toMatch(/empty result/i)
    expect(result.current.stream).toBeNull()
    expect(result.current.undoCount).toBe(0)
  })

  it('surfaces a non-abort error from the engine', async () => {
    const engine = makeEngine({
      resolveWith: '',
      throwErr: new Error('Network down'),
    })
    mockGetEngine.mockReturnValue(engine)
    const { result } = renderTF()

    await act(async () => {
      await result.current.applyAi({ defId: transformDefId('simplify'), params: {} })
    })
    expect(result.current.transformError).toBe('Network down')
    expect(result.current.stream).toBeNull()
  })
})
