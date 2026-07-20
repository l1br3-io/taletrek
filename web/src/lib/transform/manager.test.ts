import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, Chapter, VoiceId } from '../../types'
import { bookId, newBookId, newChapterId, voiceId } from '../../types'
import type {
  AiSettings,
  AiTransformEngine,
  ChunkStreamInfo,
  TransformDefinition,
  TransformOp,
} from '../ai/types'
import type { CleaningConfig } from '../clean/types'
import {
  _clearDBForTests,
  _resetDBForTests,
  getBook,
  getChaptersByBook,
  putBook,
  putChapters,
} from '../db'
import type { WakeLockHandle } from '../wake-lock'
import { bookTransformManager } from './manager'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const NOOP_HANDLE: WakeLockHandle = { async release() {} }
const acquireUploadWakeLockMock = vi.fn(async (): Promise<WakeLockHandle> => NOOP_HANDLE)

vi.mock('../wake-lock', () => ({
  acquireUploadWakeLock: () => acquireUploadWakeLockMock(),
}))

const uploadStartJobMock = vi.fn()
// `isActive` is controllable per-test so we can exercise both the stale-flag
// path (default: false → flag is cleared, transform proceeds) and the
// genuine-concurrent-synth path (true → state.error with the canonical message).
const uploadIsActiveMock = vi.fn(() => false)
vi.mock('../upload/manager', () => ({
  uploadManager: {
    startJob: (spec: unknown) => uploadStartJobMock(spec),
    isActive: () => uploadIsActiveMock(),
  },
}))

/**
 * Fake transform engine — implements the contract; onChunkStreamed fires per
 * fake-token-batch so we can verify the manager's rAF-throttled emit + state
 * transitions.
 */
function makeFakeEngine(opts?: { delayMs?: number; chunkFires?: string[] }): AiTransformEngine {
  const { delayMs = 0, chunkFires = ['Hel', 'Hello'] } = opts ?? {}
  return {
    async isReady() {
      return true
    },
    async transform(
      input: string[],
      _op: TransformOp,
      _def: TransformDefinition,
      _onProgress?: (f: number) => void,
      signal?: AbortSignal,
      _onDelta?: (textSoFar: string, delta: string) => void,
      onChunkStreamed?: (info: ChunkStreamInfo) => void,
    ): Promise<string[]> {
      // Simulate chunk streaming: fire each batch with cumulative textSoFar.
      let acc = ''
      for (const fire of chunkFires) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const delta = fire.slice(acc.length)
        acc = fire
        onChunkStreamed?.({
          chunkIndex: 0,
          chunkTotal: 1,
          chunkStartInputIndex: 0,
          chunkInputCount: input.length,
          textSoFar: acc,
          reasoningSoFar: '',
          delta,
          isFinal: false,
        })
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      }
      const finalParagraphs = input.map((p, i) => `${p} [transformed ${i}]`)
      onChunkStreamed?.({
        chunkIndex: 0,
        chunkTotal: 1,
        chunkStartInputIndex: 0,
        chunkInputCount: input.length,
        textSoFar: finalParagraphs.join('\n\n'),
        reasoningSoFar: '',
        delta: '',
        isFinal: true,
        finalParagraphs,
      })
      return finalParagraphs
    },
    async proposePronunciationHints() {
      return []
    },
    async detectOutline() {
      return []
    },
  }
}

const getAiEngineForDefMock = vi.fn((): AiTransformEngine | null => makeFakeEngine())
vi.mock('../ai/client', () => ({
  getAiEngineForDef: () => getAiEngineForDefMock(),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VOICE: VoiceId = voiceId('v1')
const CLEANING: CleaningConfig = {
  enabled: false,
  filters: { urls: false, images: false, footnotes: false, pageNumbers: false },
  pronunciation: [],
}

function makeDef(id: string, opts: Partial<TransformDefinition> = {}): TransformDefinition {
  return {
    id: id as never,
    label: id,
    hint: '',
    desc: '',
    systemPrompt: 'noop',
    params: [],
    ...opts,
  }
}

function makeAiSettings(): AiSettings {
  return {
    enabled: true,
    backend: 'cloud',
    cloud: { providers: [], activeProviderId: null },
    transformDefs: [],
  }
}

function makeBook(title = 'Test Book'): Book {
  return {
    id: newBookId(),
    title,
    format: 'txt',
    chapterCount: 2,
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeChapters(book: Book, count = 2): Chapter[] {
  return Array.from({ length: count }, (_, i) => ({
    id: newChapterId(),
    bookId: book.id,
    index: i,
    title: `Chapter ${i + 1}`,
    paragraphs: [`p${i}-0`, `p${i}-1`],
  }))
}

function makeOp(defId: string, params: Record<string, string | number> = {}): TransformOp {
  return { defId: defId as never, params }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetDBForTests()
  _clearDBForTests()
  acquireUploadWakeLockMock.mockClear()
  uploadStartJobMock.mockClear()
  uploadIsActiveMock.mockReset()
  uploadIsActiveMock.mockReturnValue(false)
  getAiEngineForDefMock.mockReset()
  getAiEngineForDefMock.mockReturnValue(makeFakeEngine())
})

afterEach(() => {
  // Reset manager state between tests (sync; clears any in-flight controller).
  bookTransformManager._resetForTests()
})

describe('bookTransformManager — start', () => {
  it('runs a single-op transform and writes final state', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    await bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )

    const state = bookTransformManager.getState()
    expect(state.type).toBe('done')

    const updated = await getBook(b.id)
    expect(updated?.transforming).toBeUndefined()
    expect(updated?.transformJob).toBeUndefined()
    expect(updated?.processing?.ops).toEqual([op])
  })

  it('persists transforming=true + transformJob from the very first tick', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    // Use an engine that blocks only the FIRST transform call; subsequent
    // calls (later chapters) return immediately. This lets us inspect mid-
    // flight state after the first chunk enters without hanging the test.
    let firstCallResolved = false
    let resolveFirst: () => void
    const blockedEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        if (!firstCallResolved) {
          await new Promise<void>((resolve) => {
            resolveFirst = resolve
          })
          firstCallResolved = true
        }
        return ['transformed']
      },
    }
    getAiEngineForDefMock.mockReturnValue(blockedEngine)

    const startPromise = bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )

    // Give the manager a tick to enter the loop.
    await new Promise((r) => setTimeout(r, 10))

    const midFlight = await getBook(b.id)
    expect(midFlight?.transforming).toBe(true)
    expect(midFlight?.transformJob?.ops).toEqual([op])
    expect(midFlight?.transformJob?.total).toBe(2)

    // Release the engine and let the loop finish.
    resolveFirst!()
    await startPromise
  })

  it('surfaces state.error when AI is disabled (not a sync throw)', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    await bookTransformManager.start(
      { book: b, chapters, ops: [makeOp('cleanup')], voiceId: VOICE, cleaning: CLEANING },
      {
        ai: { ...makeAiSettings(), enabled: false },
        defs: [makeDef('cleanup')],
        synthEnabled: false,
      },
    )
    // Pre-loop validations set state.error so the reader can surface them in
    // the GenerationBanner — a sync throw would be swallowed by the caller's
    // try/catch and leave the user staring at a dead reader.
    const state = bookTransformManager.getState()
    expect(state.type).toBe('error')
    if (state.type === 'error') expect(state.message).toMatch(/AI is not enabled/)
  })

  it('clears a stale uploading flag (set by ingest but never followed up by synth)', async () => {
    // Reproduces the 2026-07-20 regression: ingest sets `uploading: true`
    // eagerly, but when the user takes the AI-transform branch from the
    // post-upload modal, `proceedWithBook` (which kicks uploadManager.startJob)
    // is never called. The flag stays `true` forever and falsely blocks
    // Generate. The manager must detect that no real synth is running and
    // clear the flag itself.
    const b = makeBook()
    b.uploading = true
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    uploadIsActiveMock.mockReturnValue(false)
    await bookTransformManager.start(
      { book: b, chapters, ops: [makeOp('cleanup')], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [makeDef('cleanup')], synthEnabled: false },
    )
    expect(bookTransformManager.getState().type).toBe('done')
    const cleared = await getBook(b.id)
    expect(cleared?.uploading).toBeUndefined()
  })

  it('surfaces state.error when a real synth job is running', async () => {
    const b = makeBook()
    b.uploading = true
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    uploadIsActiveMock.mockReturnValue(true)
    await bookTransformManager.start(
      { book: b, chapters, ops: [makeOp('cleanup')], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [makeDef('cleanup')], synthEnabled: false },
    )
    const state = bookTransformManager.getState()
    expect(state.type).toBe('error')
    if (state.type === 'error') expect(state.message).toMatch(/Synthesis is in progress/)
    uploadIsActiveMock.mockReturnValue(false)
  })

  it('clears a paused job for the same book when start() is called again', async () => {
    // First run: pause mid-flight so we land in state.paused with a
    // persisted transformJob on the book record.
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b, 2)
    await putChapters(chapters)
    let resolveFirst: () => void
    const blockingEngine = makeFakeEngine()
    blockingEngine.transform = async () => {
      await new Promise<void>((r) => {
        resolveFirst = r
      })
      return ['out']
    }
    getAiEngineForDefMock.mockReturnValue(blockingEngine)

    const startPromise = bookTransformManager.start(
      { book: b, chapters, ops: [makeOp('cleanup')], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [makeDef('cleanup')], synthEnabled: false },
    )
    await new Promise((r) => setTimeout(r, 10))
    bookTransformManager.pause()
    resolveFirst!()
    await startPromise.catch(() => {})
    expect(bookTransformManager.getState().type).toBe('paused')
    const pausedBook = await getBook(b.id)
    expect(pausedBook?.transformJob).toBeDefined()

    // Second start() with a new spec — should clear the paused job and run.
    getAiEngineForDefMock.mockReturnValue(makeFakeEngine())
    await bookTransformManager.start(
      { book: b, chapters, ops: [makeOp('cleanup')], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [makeDef('cleanup')], synthEnabled: false },
    )
    expect(bookTransformManager.getState().type).toBe('done')
    const clearedBook = await getBook(b.id)
    expect(clearedBook?.transformJob).toBeUndefined()
  })

  it('transitions to error state when no engine is configured for the def', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    getAiEngineForDefMock.mockReturnValue(null)
    await bookTransformManager.start(
      { book: b, chapters, ops: [makeOp('cleanup')], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [makeDef('cleanup')], synthEnabled: false },
    )
    expect(bookTransformManager.getState().type).toBe('error')
    const errState = bookTransformManager.getState()
    if (errState.type === 'error') {
      expect(errState.message).toMatch(/No provider configured/)
    }
  })
})

describe('bookTransformManager — pause', () => {
  it('pauses a running job and converts to paused state with transforming=false', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    let resolveTransform: () => void
    const blockedEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        await new Promise<void>((resolve) => {
          resolveTransform = resolve
        })
        return ['transformed']
      },
    }
    getAiEngineForDefMock.mockReturnValue(blockedEngine)

    const startPromise = bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )

    // Wait for the loop to enter, then pause.
    await new Promise((r) => setTimeout(r, 10))
    bookTransformManager.pause()

    // Resolve the blocked transform so the abort can propagate.
    resolveTransform!()
    await startPromise

    const state = bookTransformManager.getState()
    expect(state.type).toBe('paused')
    if (state.type === 'paused') {
      expect(state.bookId).toBe(b.id)
    }

    const updated = await getBook(b.id)
    expect(updated?.transforming).toBe(false) // load-bearing — boot sweep ignores
    expect(updated?.transformJob?.ops).toEqual([op])
  })
})

describe('bookTransformManager — resume', () => {
  it('resumes from a persisted transformJob and completes the remaining chapters', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    // Persist a paused spec at op 0, chapter 1 (chapter 0 already done).
    b.transforming = false
    b.transformJob = {
      ops: [op],
      voiceId: VOICE,
      cleaning: CLEANING,
      currentOpIndex: 0,
      currentChapterIndex: 1,
      done: 1,
      total: 2,
      pausedAt: 0,
    }
    await putBook(b)

    await bookTransformManager.resume(b.id, {
      ai: makeAiSettings(),
      defs: [def],
      synthEnabled: false,
    })

    expect(bookTransformManager.getState().type).toBe('done')
    const updated = await getBook(b.id)
    expect(updated?.transformJob).toBeUndefined()
    expect(updated?.transforming).toBeUndefined()
  })

  it('throws when no paused transformJob exists', async () => {
    const b = makeBook()
    await putBook(b)
    await expect(
      bookTransformManager.resume(b.id, {
        ai: makeAiSettings(),
        defs: [makeDef('cleanup')],
        synthEnabled: false,
      }),
    ).rejects.toThrow(/No paused transform job/)
  })

  it('resumes from an explicit in-session pause (banner Pause → Resume flow)', async () => {
    // Regression test: the banner's Resume button was broken because
    // `resume()` rejected whenever state was 'paused' — the very state the
    // button is shown in. The void-discard at the call site hid the throw.
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    // Block the first chapter's transform so we can pause mid-stream.
    let resolveTransform: () => void
    const blockedEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        await new Promise<void>((resolve) => {
          resolveTransform = resolve
        })
        return ['transformed']
      },
    }
    getAiEngineForDefMock.mockReturnValue(blockedEngine)

    const startPromise = bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )
    await new Promise((r) => setTimeout(r, 10))
    bookTransformManager.pause()
    resolveTransform!()
    await startPromise

    expect(bookTransformManager.getState().type).toBe('paused')

    // Now swap in a real engine and resume — must NOT throw.
    getAiEngineForDefMock.mockReturnValue(makeFakeEngine())
    await bookTransformManager.resume(b.id, {
      ai: makeAiSettings(),
      defs: [def],
      synthEnabled: false,
    })

    expect(bookTransformManager.getState().type).toBe('done')
    const updated = await getBook(b.id)
    expect(updated?.transformJob).toBeUndefined()
    expect(updated?.transforming).toBeUndefined()
  })
})

describe('bookTransformManager — cancel', () => {
  it('clears persisted state on cancel and returns to idle (keeps committed chapters)', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    // Start, pause, then cancel.
    let resolveTransform: () => void
    const blockedEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        await new Promise<void>((resolve) => {
          resolveTransform = resolve
        })
        return []
      },
    }
    getAiEngineForDefMock.mockReturnValue(blockedEngine)

    const startPromise = bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )
    await new Promise((r) => setTimeout(r, 10))
    bookTransformManager.pause()
    resolveTransform!()
    await startPromise

    await bookTransformManager.cancel()

    expect(bookTransformManager.getState().type).toBe('idle')
    const updated = await getBook(b.id)
    expect(updated?.transformJob).toBeUndefined()
    expect(updated?.transforming).toBeUndefined()
  })

  it('cancelForBook is a no-op when no job is active', async () => {
    const result = await bookTransformManager.cancelForBook(bookId('any-id'))
    expect(result).toEqual({ type: 'no-op' })
  })

  it('cancelForBook is blocked when a transform is active for another book', async () => {
    const active = makeBook('Active Transform')
    const other = makeBook('Target Other')
    await putBook(active)
    await putBook(other)
    await putChapters(makeChapters(active))
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    let resolveTransform: () => void
    const blockedEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        await new Promise<void>((resolve) => {
          resolveTransform = resolve
        })
        return []
      },
    }
    getAiEngineForDefMock.mockReturnValue(blockedEngine)

    const startPromise = bookTransformManager.start(
      {
        book: active,
        chapters: makeChapters(active),
        ops: [op],
        voiceId: VOICE,
        cleaning: CLEANING,
      },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )
    await new Promise((r) => setTimeout(r, 10))
    await vi.waitFor(() => expect(bookTransformManager.getState().type).toBe('running'))

    const result = await bookTransformManager.cancelForBook(other.id)
    expect(result).toEqual({ type: 'blocked', activeBookTitle: 'Active Transform' })
    expect(bookTransformManager.getState().type).toBe('running')

    // Cleanup so subsequent tests start from idle.
    bookTransformManager.pause()
    resolveTransform!()
    await startPromise
    await bookTransformManager.cancel()
  })

  it('cancelForBook cancels a running transform for the same book and awaits idle', async () => {
    const b = makeBook('Cancellable Transform')
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    let resolveTransform: () => void
    const blockedEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        await new Promise<void>((resolve) => {
          resolveTransform = resolve
        })
        return []
      },
    }
    getAiEngineForDefMock.mockReturnValue(blockedEngine)

    const startPromise = bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )
    await new Promise((r) => setTimeout(r, 10))
    await vi.waitFor(() => expect(bookTransformManager.getState().type).toBe('running'))

    const resultPromise = bookTransformManager.cancelForBook(b.id)
    resolveTransform!()
    const result = await resultPromise
    await startPromise

    expect(result).toEqual({ type: 'cancelled' })
    expect(bookTransformManager.getState().type).toBe('idle')
  })
})

describe('bookTransformManager — reductive ops', () => {
  it('clears chapter.headings when the op is reductive', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    // Add legacy headings to verify defensive clear.
    chapters[0]!.headings = [{ paragraphIndex: 0, title: 'Legacy' }]
    await putChapters(chapters)

    const summarizeDef = makeDef('summarize', {
      params: [{ key: 'ratio', type: 'range', label: 'Ratio', default: 0.5 }],
    })
    const op: TransformOp = { defId: 'summarize' as never, params: { ratio: 0.5 } }

    await bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [summarizeDef], synthEnabled: false },
    )

    const updated = await getChaptersByBook(b.id)
    const refreshed = updated.find((c) => c.id === chapters[0]!.id)
    expect(refreshed?.headings).toBeUndefined()
  })
})

describe('bookTransformManager — sequential TTS resynth', () => {
  it('kicks uploadManager.startJob with mode=resynth when synthMode is on', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    await bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: true },
    )

    // Resynth is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 20))
    expect(uploadStartJobMock).toHaveBeenCalledTimes(1)
    const callArg = uploadStartJobMock.mock.calls[0]?.[0]
    expect(callArg?.mode).toBe('resynth')
    expect(callArg?.voiceId).toBe(VOICE)
  })

  it('does not kick resynth when synthMode is off', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    await bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(uploadStartJobMock).not.toHaveBeenCalled()
  })
})

describe('bookTransformManager — subscribe', () => {
  it('notifies subscribers on state transitions', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    const listener = vi.fn()
    const unsub = bookTransformManager.subscribe(listener)
    // Reference the listener count to satisfy TS; subscribing once is enough.
    expect(typeof unsub).toBe('function')

    await bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )
    expect(listener).toHaveBeenCalled()
    unsub()
  })

  it('streamingParagraphs emit uses setTimeout, not requestAnimationFrame', async () => {
    // Rationale: rAF throttles to ~1Hz or stalls when the tab is hidden
    // (gotcha #23 cousin), which would freeze the streaming block any time
    // the user switches tabs during a transform. This test pins the
    // implementation to the setInterval family so a future refactor can't
    // silently regress to rAF.
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b, 1)
    await putChapters(chapters)
    getAiEngineForDefMock.mockReturnValue(
      makeFakeEngine({
        delayMs: 0,
        chunkFires: ['Hel', 'Hello', 'Hello world'],
      }),
    )
    await bookTransformManager.start(
      { book: b, chapters, ops: [makeOp('cleanup')], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [makeDef('cleanup')], synthEnabled: false },
    )
    // Drain any pending setTimeout(250ms) so the test leaves no litter.
    await new Promise((r) => setTimeout(r, 300))
    expect(rafSpy).not.toHaveBeenCalled()
    rafSpy.mockRestore()
  })
})

describe('bookTransformManager — visibility recovery (Issue 4)', () => {
  const setVisible = (v: boolean) =>
    Object.defineProperty(document, 'visibilityState', {
      value: v ? 'visible' : 'hidden',
      configurable: true,
    })
  const dispatch = () => document.dispatchEvent(new Event('visibilitychange'))

  it('recovers (pause → resume) when the tab was hidden longer than the lock threshold', async () => {
    const b = makeBook('Locky Transform')
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    // Track ALL pending transform resolvers so the test can release each
    // call independently — recovery's resume kicks off a second call, and
    // the original `resolveTransform` pattern (single variable) couldn't
    // express that.
    const resolvers: Array<() => void> = []
    const blockedEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        await new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
        return []
      },
    }
    getAiEngineForDefMock.mockReturnValue(blockedEngine)

    const startPromise = bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )
    await new Promise((r) => setTimeout(r, 10))
    await vi.waitFor(() => expect(bookTransformManager.getState().type).toBe('running'))
    await vi.waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(1))
    expect(bookTransformManager.isRecovering()).toBe(false)

    // Hide >5s → visible: triggers recovery.
    setVisible(false)
    dispatch()
    vi.setSystemTime(Date.now() + 6_000)
    setVisible(true)
    dispatch()

    await vi.waitFor(() => expect(bookTransformManager.isRecovering()).toBe(true))

    // Release the first transform so the original loop's catch lands at
    // paused; recovery then resumes into chapter 2's transform call.
    resolvers[0]?.()
    await startPromise
    // Wait for the resume's second call to land, then release it so the
    // resumed runLoop can complete and recovery's `recovering` flag clears.
    await vi.waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(2))
    resolvers[1]?.()

    // Recovery completes once the resumed loop settles. Drain any
    // setTimeout(250ms) emits so the test leaves no litter.
    await vi.waitFor(() => expect(bookTransformManager.isRecovering()).toBe(false), {
      timeout: 3000,
    })
    // Release any stragglers so the next test starts clean.
    for (const r of resolvers) r()
    await new Promise((r) => setTimeout(r, 300))
    expect(bookTransformManager.getState().type).not.toBe('error')
    vi.useRealTimers()
  })

  it('does NOT recover when the tab was hidden briefly (tab switch)', async () => {
    const b = makeBook('Tabby Transform')
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    const resolvers: Array<() => void> = []
    const blockedEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        await new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
        return []
      },
    }
    getAiEngineForDefMock.mockReturnValue(blockedEngine)

    const startPromise = bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )
    await new Promise((r) => setTimeout(r, 10))
    await vi.waitFor(() => expect(bookTransformManager.getState().type).toBe('running'))

    // Hide <5s → visible: should NOT trigger recovery.
    setVisible(false)
    dispatch()
    vi.setSystemTime(Date.now() + 2_000)
    setVisible(true)
    dispatch()
    await new Promise((r) => setTimeout(r, 10))

    expect(bookTransformManager.isRecovering()).toBe(false)
    expect(bookTransformManager.getState().type).toBe('running')

    // Cleanup.
    bookTransformManager.pause()
    resolvers[0]?.()
    await startPromise
    await bookTransformManager.cancel()
    vi.useRealTimers()
  })
})

describe('bookTransformManager — error handling', () => {
  it('transitions to error state when transform throws non-AbortError', async () => {
    const b = makeBook()
    await putBook(b)
    const chapters = makeChapters(b)
    await putChapters(chapters)
    const def = makeDef('cleanup')
    const op = makeOp('cleanup')

    const failingEngine: AiTransformEngine = {
      ...makeFakeEngine(),
      async transform() {
        throw new Error('LLM is down')
      },
    }
    getAiEngineForDefMock.mockReturnValue(failingEngine)

    await bookTransformManager.start(
      { book: b, chapters, ops: [op], voiceId: VOICE, cleaning: CLEANING },
      { ai: makeAiSettings(), defs: [def], synthEnabled: false },
    )

    const state = bookTransformManager.getState()
    expect(state.type).toBe('error')
    if (state.type === 'error') {
      expect(state.message).toMatch(/LLM is down/)
    }
  })
})

// ---------------------------------------------------------------------------
// Boot sweep (separate concerns, but co-located for now since the types are here)
// ---------------------------------------------------------------------------

import { reconcileInterruptedTransforms } from '../upload/boot-sweep'

describe('reconcileInterruptedTransforms', () => {
  it('clears transforming flag for stuck books (no transformJob — legacy edge)', async () => {
    const b = makeBook()
    b.transforming = true
    await putBook(b)
    const result = await reconcileInterruptedTransforms()
    expect(result.transformedToPaused).toBe(1)
    const updated = await getBook(b.id)
    expect(updated?.transforming).toBeUndefined()
  })

  it('converts interrupted transforms with persisted transformJob to paused', async () => {
    const b = makeBook()
    b.transforming = true
    b.transformJob = {
      ops: [makeOp('cleanup')],
      voiceId: VOICE,
      cleaning: CLEANING,
      currentOpIndex: 0,
      currentChapterIndex: 1,
      done: 1,
      total: 2,
      pausedAt: 0,
    }
    await putBook(b)
    const result = await reconcileInterruptedTransforms()
    expect(result.transformedToPaused).toBe(1)
    const updated = await getBook(b.id)
    expect(updated?.transforming).toBeUndefined()
    expect(updated?.transformJob).toBeDefined() // preserved for library Resume
  })

  it('ignores books with transforming=false (explicit pause)', async () => {
    const b = makeBook()
    b.transforming = false
    b.transformJob = {
      ops: [makeOp('cleanup')],
      voiceId: VOICE,
      cleaning: CLEANING,
      currentOpIndex: 0,
      currentChapterIndex: 0,
      done: 0,
      total: 2,
      pausedAt: 0,
    }
    await putBook(b)
    const result = await reconcileInterruptedTransforms()
    expect(result.transformedToPaused).toBe(0)
  })
})
