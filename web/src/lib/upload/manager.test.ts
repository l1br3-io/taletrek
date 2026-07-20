import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, Chapter } from '../../types'
import { bookId, newBookId, newChapterId, voiceId } from '../../types'
import { _clearDBForTests, _resetDBForTests, getBook, putBook, putChapters } from '../db'
import type { WakeLockHandle } from '../wake-lock'
import { type JobState, uploadManager } from './manager'
import { useUploadState } from './useUpload'

const synthMock =
  vi.fn<
    (
      ...args: unknown[]
    ) => Promise<{ audio?: Blob; synthMs: number; durationSeconds: number; cacheKey: string }>
  >()
const isStoredMock = vi.fn<(...args: unknown[]) => Promise<boolean>>()
const downloadMock = vi.fn<(...args: unknown[]) => Promise<void>>()
const putBookAudioMock = vi.fn<(...args: unknown[]) => Promise<void>>()
const acquireUploadWakeLock = vi.fn<() => Promise<WakeLockHandle>>()
const wakeLockRelease = vi.fn<() => Promise<void>>()

vi.mock('../tts/client', () => ({
  ttsClient: {
    isStored: (...args: unknown[]) => isStoredMock(...args),
    download: (...args: unknown[]) => downloadMock(...args),
    synthesize: (...args: unknown[]) => synthMock(...args),
    listVoices: async () => [],
    remove: async () => {},
  },
}))

/**
 * Mock the parallel-synthesis pool (ADR-0011) as a passthrough that delegates
 * every TtsEngine op to the (mocked) singleton `ttsClient`. This preserves the
 * pre-pool test contract — `synthMock` etc. remain the control surface — while
 * exposing `concurrency` so `preSynthesizeBook`'s dispatch-window hint is real.
 * Dedicated pool behaviour is covered by `pool.test.ts`.
 */
vi.mock('../tts/pool', () => ({
  PoolEngine: class {
    readonly concurrency: number
    private readonly voiceEngine: unknown
    constructor(concurrency: number, voiceEngine: unknown) {
      this.concurrency = concurrency
      this.voiceEngine = voiceEngine
    }
    async synthesize(req: unknown) {
      // @ts-expect-error — voiceEngine is typed unknown to avoid importing the real type
      return this.voiceEngine.synthesize(req)
    }
    async listVoices() {
      // @ts-expect-error — same as above
      return this.voiceEngine.listVoices()
    }
    async isStored(id: unknown) {
      // @ts-expect-error — same as above
      return this.voiceEngine.isStored(id)
    }
    async download(id: unknown, onProgress?: (f: number) => void) {
      // @ts-expect-error — same as above
      return this.voiceEngine.download(id, onProgress)
    }
    async remove(id: unknown) {
      // @ts-expect-error — same as above
      return this.voiceEngine.remove(id)
    }
    async clearAllStored() {
      // @ts-expect-error — same as above
      return this.voiceEngine.clearAllStored()
    }
    dispose() {}
  },
}))

vi.mock('../tts/pool-size', () => ({
  preferredPoolSize: () => 1,
}))

vi.mock('../book-audio', () => ({
  putBookAudio: (...args: unknown[]) => putBookAudioMock(...args),
  getBookAudio: async () => undefined,
}))

const loadCoreMock = vi.fn<(...args: unknown[]) => Promise<void>>()
const concatMock =
  vi.fn<
    (...args: unknown[]) => Promise<{
      m4a: ArrayBuffer
      paragraphOffsets: number[]
      durations: number[]
      duration: number
    }>
  >()

vi.mock('../audio/concat-client', () => ({
  concatClient: {
    loadCore: (...args: unknown[]) => loadCoreMock(...args),
    concat: (...args: unknown[]) => concatMock(...args),
  },
}))

vi.mock('../wake-lock', () => ({
  acquireUploadWakeLock: () => acquireUploadWakeLock(),
}))

/**
 * Force-resolve the mobile engine to FFmpeg so the encode path stays exercisable
 * in jsdom (which can't express `HTMLVideoElement.canPlayType` / OPFS support, so
 * the real `resolveMobileEngine` would fall back to 'web-audio' and skip the
 * encode — ADR-0010). Per-test overrides via `resolveEngineMock.mockReturnValue`.
 */
const resolveEngineMock = vi.fn<(...args: unknown[]) => 'web-audio' | 'ffmpeg'>()
vi.mock('../playback/engines', async (importActual) => {
  const actual = await importActual<typeof import('../playback/engines')>()
  return { ...actual, resolveMobileEngine: (...args: unknown[]) => resolveEngineMock(...args) }
})

function makeBook(title = 'Test Book'): Book {
  const now = Date.now()
  return {
    id: newBookId(),
    title,
    format: 'txt',
    chapterCount: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function makeChapters(): Chapter[] {
  const bid = newBookId()
  return [
    {
      id: newChapterId(),
      bookId: bid,
      index: 0,
      title: 'Chapter 1',
      paragraphs: ['Hello world.', 'Second paragraph.', '   ', 'Third.'],
    },
  ]
}

const idleCleaning = {
  enabled: false,
  filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
  pronunciation: [],
}

function stubMobilePointer(isMobile: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: isMobile && query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  synthMock.mockReset()
  isStoredMock.mockReset()
  downloadMock.mockReset()
  putBookAudioMock.mockReset()
  loadCoreMock.mockReset()
  concatMock.mockReset()
  acquireUploadWakeLock.mockReset()
  wakeLockRelease.mockReset()
  isStoredMock.mockResolvedValue(true)
  putBookAudioMock.mockResolvedValue(undefined)
  loadCoreMock.mockResolvedValue(undefined)
  concatMock.mockResolvedValue({
    m4a: new ArrayBuffer(8),
    paragraphOffsets: [0],
    durations: [1],
    duration: 1,
  })
  synthMock.mockResolvedValue({
    audio: new Blob(['x']),
    synthMs: 100,
    durationSeconds: 1,
    cacheKey: 'k',
  })
  acquireUploadWakeLock.mockResolvedValue({ release: wakeLockRelease })
  resolveEngineMock.mockReset()
  resolveEngineMock.mockReturnValue('ffmpeg')
  uploadManager._resetForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  uploadManager._resetForTests()
})

describe('uploadManager', () => {
  it('rejects a second job while one is active', () => {
    // Gate the synth so the first job stays in-flight.
    synthMock.mockReturnValue(new Promise(() => {}))
    const book = makeBook()
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    expect(() =>
      uploadManager.startJob({
        book: makeBook('Second'),
        chapters: makeChapters(),
        voiceId: voiceId('en_US-hfc_female-medium'),
        cleaning: idleCleaning,
      }),
    ).toThrow(/already running/)
  })

  it('runs to done and synthesizes all non-empty paragraphs', async () => {
    const book = makeBook()
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    // Wait for done by polling.
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
    expect(synthMock).toHaveBeenCalledTimes(3) // whitespace paragraph skipped
    expect(acquireUploadWakeLock).toHaveBeenCalledTimes(1)
    expect(wakeLockRelease).toHaveBeenCalledTimes(1)
  })

  it('tracks synthesizedParagraphIds as paragraphs complete', async () => {
    const book = makeBook()
    const chapters = makeChapters()
    // Gate each synth call so we can observe intermediate states.
    const gates: Array<() => void> = []
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() =>
            res({ audio: new Blob(['x']), synthMs: 50, durationSeconds: 1, cacheKey: 'k' }),
          )
        }),
    )
    uploadManager.startJob({
      book,
      chapters,
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    // After voice check + first synth is called, resolve it.
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1))
    act(() => gates[0]?.())
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(2))

    const state = uploadManager.getState()
    expect(state.type).toBe('synthesizing')
    if (state.type === 'synthesizing') {
      expect(state.done).toBe(1)
      expect(state.total).toBe(3)
      // First non-empty paragraph id is `${chapterId}:0`.
      const firstId = `${chapters[0]?.id}:0`
      expect(state.synthesizedParagraphIds.has(firstId)).toBe(true)
    }
    // Release remaining gates so the job can finish.
    await act(async () => {
      gates[1]?.()
    })
    // Wait for the next synthesize call to push gate[2] before resolving it.
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3))
    await act(async () => {
      gates[2]?.()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
  })

  it('surfaces an ETA once a non-cache-hit synth sample lands', async () => {
    // ETA plumbing (issue #2): `synthMs > 0` samples accumulate into a
    // rolling window, and `etaMs = (total - done) * avg / concurrency`.
    // `synthMs === 0` (cache hit) must NOT contribute — see manager.ts.
    const book = makeBook()
    const chapters = makeChapters()
    const gates: Array<() => void> = []
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() =>
            // 200ms synth wall-clock — non-zero so it counts toward the average.
            res({ audio: new Blob(['x']), synthMs: 200, durationSeconds: 1, cacheKey: 'k' }),
          )
        }),
    )
    uploadManager.startJob({
      book,
      chapters,
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1))
    act(() => gates[0]?.())

    await vi.waitFor(() => {
      const s = uploadManager.getState()
      expect(s.type).toBe('synthesizing')
      if (s.type === 'synthesizing') expect(s.etaMs).toBeDefined()
    })

    // Verify the math: 1 ¶ done, 3 total, avg=200ms, concurrency=1 (mocked).
    // → (3 - 1) * 200 / 1 = 400ms remaining.
    const s = uploadManager.getState()
    if (s.type === 'synthesizing') {
      expect(s.etaMs).toBe(400)
    }

    // Drain remaining gates so the job can finish cleanly.
    await act(async () => {
      gates[1]?.()
    })
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3))
    await act(async () => {
      gates[2]?.()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
  })

  it('excludes cache hits (synthMs === 0) from the ETA average', async () => {
    // Resume fast-forward path: cache hits must not crash the average
    // toward zero (which would predict absurdly short remaining times).
    const book = makeBook()
    const chapters = makeChapters()
    const gates: Array<() => void> = []
    let call = 0
    synthMock.mockImplementation(() => {
      call++
      // First call: real synth (100ms). Subsequent: cache hits (0ms).
      const synthMs = call === 1 ? 100 : 0
      return new Promise((res) => {
        gates.push(() =>
          res({ audio: new Blob(['x']), synthMs, durationSeconds: 1, cacheKey: 'k' }),
        )
      })
    })
    uploadManager.startJob({
      book,
      chapters,
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1))
    act(() => gates[0]?.())

    // After the first real synth lands, ETA should be based on 100ms only
    // (the cache-hit contributions are dropped before averaging).
    // (3 - 1) * 100 / 1 = 200ms — cache hits from ¶s 2/3 must not pull it down.
    await vi.waitFor(() => {
      const s = uploadManager.getState()
      expect(s.type).toBe('synthesizing')
      if (s.type === 'synthesizing') expect(s.etaMs).toBe(200)
    })

    // Drain.
    await act(async () => gates[1]?.())
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3))
    await act(async () => gates[2]?.())
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
  })

  it('cancel aborts and returns to idle', async () => {
    const book = makeBook()
    // Gate synth so the job stays in-flight on the first paragraph.
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' })
        }),
    )
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    // Wait for the first synth call, then cancel. Cancel is cooperative — the
    // signal is checked between paragraphs, so the in-flight synth must resolve
    // before the loop sees the abort and returns.
    await vi.waitFor(() => expect(synthMock).toHaveBeenCalled())
    uploadManager.cancel()
    await act(async () => {
      resolveFirst?.()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('idle'))
    expect(acquireUploadWakeLock).toHaveBeenCalledTimes(1)
    expect(wakeLockRelease).toHaveBeenCalledTimes(1)
  })

  it('cancel transitions to cancelling immediately for UX feedback', async () => {
    const book = makeBook('Gated')
    // Never-resolving synth keeps the job in-flight.
    synthMock.mockReturnValue(new Promise(() => {}))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(synthMock).toHaveBeenCalled())
    // Synchronously after cancel(), state must be `cancelling` — no awaiting.
    uploadManager.cancel()
    const state = uploadManager.getState()
    expect(state.type).toBe('cancelling')
    if (state.type === 'cancelling') {
      expect(state.book.id).toBe(book.id)
      expect(state.mode).toBe('initial')
    }
    expect(uploadManager.isActive()).toBe(true)
  })

  it('cancel is a no-op when no job is active', () => {
    expect(uploadManager.isActive()).toBe(false)
    expect(() => uploadManager.cancel()).not.toThrow()
    expect(uploadManager.getState().type).toBe('idle')
  })

  it('pause transitions to pausing immediately for UX feedback', async () => {
    // Mirror of the "cancel transitions to cancelling" test above. Without
    // the synchronous flip, the banner would keep showing "Synthesizing…"
    // for up to several seconds while the in-flight Piper inference
    // finishes — looking frozen to the user (issue #5).
    const book = makeBook('Pausing')
    await putBook(book)
    // Never-resolving synth keeps the job in-flight so we can observe the
    // synchronous transition before finalizeAfterAbort runs.
    synthMock.mockReturnValue(new Promise(() => {}))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(synthMock).toHaveBeenCalled())
    // Synchronously after pause(), state must be `pausing` — no awaiting.
    uploadManager.pause()
    const state = uploadManager.getState()
    expect(state.type).toBe('pausing')
    if (state.type === 'pausing') {
      expect(state.book.id).toBe(book.id)
      expect(state.mode).toBe('initial')
    }
    // A pausing job is still active — startJob must reject a second one.
    expect(uploadManager.isActive()).toBe(true)
    // The pause button is hidden once pauseRequested is true.
    expect(uploadManager.canPause()).toBe(false)
  })

  it('pause persists the resumable spec and transitions to paused (ADR-0010)', async () => {
    const book = makeBook('Pausable')
    await putBook(book)
    // Gate the first synth so the job is in-flight when we pause.
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' })
        }),
    )
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(synthMock).toHaveBeenCalled())
    uploadManager.pause()
    await act(async () => {
      resolveFirst?.()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('paused'))

    const state = uploadManager.getState()
    expect(state.type).toBe('paused')
    if (state.type === 'paused') {
      expect(state.done).toBe(1) // ¶0 synthesized before the abort was observed
      expect(state.total).toBe(3)
    }
    // The persisted spec carries the resumable job; uploading is false so
    // ADR-0009's boot sweep ignores the book.
    const saved = await getBook(book.id)
    expect(saved?.uploadJob).toBeDefined()
    expect(saved?.uploadJob?.voiceId).toBe(voiceId('en_US-hfc_female-medium'))
    expect(saved?.uploadJob?.done).toBe(1)
    expect(saved?.uploadJob?.total).toBe(3)
    expect(saved?.uploading).toBe(false)
    // A paused job is not active, so another job could start.
    expect(uploadManager.isActive()).toBe(false)
  })

  it('resume reloads the spec from IDB and re-runs the job to completion', async () => {
    const book = makeBook('Resumable')
    const chapters = makeChapters()
    // Tie the chapters to this book so getChaptersByBook finds them on resume.
    const firstChapter = chapters[0]
    if (firstChapter) firstChapter.bookId = book.id
    await putBook(book)
    await putChapters(chapters)

    // Pause after one paragraph.
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' })
        }),
    )
    uploadManager.startJob({
      book,
      chapters,
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(synthMock).toHaveBeenCalled())
    uploadManager.pause()
    await act(async () => {
      resolveFirst?.()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('paused'))

    // Resume: synth now resolves normally; cache hits make it fast-forward.
    synthMock.mockResolvedValue({
      audio: new Blob(['x']),
      synthMs: 0,
      durationSeconds: 1,
      cacheKey: 'k',
    })
    await uploadManager.resume(book.id)
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))

    const saved = await getBook(book.id)
    expect(saved?.uploadJob).toBeUndefined()
    expect(saved?.uploading).toBeUndefined()
  })

  it('resume is a no-op when the book has no paused spec', async () => {
    const book = makeBook('Nothing to resume')
    await putBook(book)
    await uploadManager.resume(book.id)
    expect(uploadManager.getState().type).toBe('idle')
  })

  it('transitions to error on synth failure', async () => {
    const book = makeBook()
    synthMock.mockRejectedValue(new Error('worker exploded'))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    const state = await vi.waitFor(() => {
      const s = uploadManager.getState()
      expect(s.type).toBe('error')
      return s
    })
    expect((state as Extract<JobState, { type: 'error' }>).message).toBe(
      "Synth failed at chapter 1 'Chapter 1', paragraph 1/3 (¶ 1/3 overall): worker exploded",
    )
  })

  it('initial mode keeps the book on failure and offers retry', async () => {
    const book = makeBook('Doomed Upload')
    await putBook(book)
    synthMock.mockRejectedValue(new Error('boom'))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
      // mode omitted → defaults to 'initial'
    })
    const state = await vi.waitFor(() => {
      const s = uploadManager.getState()
      expect(s.type).toBe('error')
      return s as Extract<JobState, { type: 'error' }>
    })
    expect(state.mode).toBe('initial')
    // Book is kept so the user can retry — cascade-deleting was too aggressive.
    expect(await getBook(book.id)).toBeDefined()
    const kept = await getBook(book.id)
    expect(kept?.uploading).toBeUndefined()
    expect(uploadManager.canRetry()).toBe(true)
    // Wake lock still released on the error path.
    expect(wakeLockRelease).toHaveBeenCalledTimes(1)
  })

  it('resynth mode keeps the book on failure and offers retry', async () => {
    const book = makeBook('Transformed Book')
    await putBook(book)
    synthMock.mockRejectedValue(new Error('transient API error'))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
      mode: 'resynth',
    })
    const state = await vi.waitFor(() => {
      const s = uploadManager.getState()
      expect(s.type).toBe('error')
      return s as Extract<JobState, { type: 'error' }>
    })
    expect(state.mode).toBe('resynth')
    // Book survives — the user's text is intact.
    expect(await getBook(book.id)).toBeDefined()
    expect(uploadManager.canRetry()).toBe(true)
  })

  it('resynth retry re-runs the job and can succeed', async () => {
    const book = makeBook('Retry Me')
    await putBook(book)
    synthMock.mockRejectedValueOnce(new Error('transient'))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
      mode: 'resynth',
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('error'))
    expect(uploadManager.canRetry()).toBe(true)
    uploadManager.retry()
    await vi.waitFor(() => {
      const s = uploadManager.getState()
      expect(s.type).toBe('done')
      expect((s as Extract<JobState, { type: 'done' }>).mode).toBe('resynth')
    })
  })

  it('dismiss clears done/error back to idle', async () => {
    const book = makeBook()
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
    uploadManager.dismiss()
    expect(uploadManager.getState().type).toBe('idle')
  })

  it('snapshots voiceId — a setting change after start does not drift', async () => {
    const book = makeBook()
    const chapters = makeChapters()
    // Slow synth so we can inspect calls mid-job.
    const gates: Array<() => void> = []
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() =>
            res({ audio: new Blob(['x']), synthMs: 50, durationSeconds: 1, cacheKey: 'k' }),
          )
        }),
    )
    uploadManager.startJob({
      book,
      chapters,
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1))
    // Release all gates; every call should use the original voice.
    act(() => gates[0]?.())
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(2))
    act(() => gates[1]?.())
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3))
    act(() => gates[2]?.())
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
    for (const call of synthMock.mock.calls) {
      const req = call[0] as { voiceId: string }
      expect(req.voiceId).toBe('en_US-hfc_female-medium')
    }
  })

  it('keeps the book and offers retry on transient initial storage errors', async () => {
    const book = makeBook('Storage Pressure')
    await putBook(book)
    synthMock.mockRejectedValue(new DOMException('quota exceeded', 'QuotaExceededError'))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    const state = await vi.waitFor(() => {
      const s = uploadManager.getState()
      expect(s.type).toBe('error')
      return s as Extract<JobState, { type: 'error' }>
    })
    expect(state.mode).toBe('initial')
    expect(state.retryable).toBe(true)
    expect(uploadManager.canRetry()).toBe(true)
    // Book is preserved and uploading flag is cleared.
    const saved = await getBook(book.id)
    expect(saved).toBeDefined()
    expect(saved?.uploading).toBeUndefined()
  })

  it('skips mobile encode for books that would exceed the size cap', async () => {
    stubMobilePointer(true)
    const book = makeBook('Huge Book')
    await putBook(book)
    // Each paragraph reports ~8h of audio → >200 MB m4a estimate.
    synthMock.mockResolvedValue({
      audio: new Blob(['x']),
      synthMs: 100,
      durationSeconds: 30_000,
      cacheKey: 'k',
    })
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
    expect(putBookAudioMock).not.toHaveBeenCalled()
    const saved = await getBook(book.id)
    expect(saved?.uploading).toBeUndefined()
  })

  it('retries putBookAudio once on quota and skips encode if quota persists', async () => {
    stubMobilePointer(true)
    const book = makeBook('Quota Book')
    await putBook(book)
    putBookAudioMock.mockRejectedValue(new DOMException('quota exceeded', 'QuotaExceededError'))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
    expect(putBookAudioMock).toHaveBeenCalledTimes(2)
    const saved = await getBook(book.id)
    expect(saved?.uploading).toBeUndefined()
  })

  it('recovers mobile encode when putBookAudio quota clears on retry', async () => {
    stubMobilePointer(true)
    const book = makeBook('Recovering Book')
    await putBook(book)
    putBookAudioMock
      .mockRejectedValueOnce(new DOMException('quota exceeded', 'QuotaExceededError'))
      .mockResolvedValueOnce(undefined)
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
    expect(putBookAudioMock).toHaveBeenCalledTimes(2)
  })

  it('skips the whole-book encode when the Web Audio engine is resolved (ADR-0010)', async () => {
    stubMobilePointer(true)
    resolveEngineMock.mockReturnValue('web-audio')
    const book = makeBook('Web Audio Book')
    await putBook(book)
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
    // No m4a is built — the Web Audio engine reads paragraph WAVs directly.
    expect(putBookAudioMock).not.toHaveBeenCalled()
    expect(loadCoreMock).not.toHaveBeenCalled()
  })

  it('persists uploadJob at runJob start so an eviction becomes resumable', async () => {
    // The fresh-upload contract: a book that gets its tab evicted mid-synth
    // must land in the library as Paused, not vanish. That requires uploadJob
    // to be in IDB from the very first tick — if it's only written on pause,
    // a surprise eviction loses everything.
    const book = { ...makeBook('Eviction-Proof'), uploading: true }
    await putBook(book)
    // Gated synth so cancel() can finalize (cooperative abort only resolves
    // at the next paragraph boundary — never-resolving synth would strand
    // state in 'cancelling' for the duration of the test).
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' })
        }),
    )
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    // Wait for the persisted uploadJob to land — runJob writes it inside the
    // try block (after wake lock acquire), so it lags setState by a tick.
    await vi.waitFor(async () => {
      const saved = await getBook(book.id)
      expect(saved?.uploadJob).toBeDefined()
    })

    const inFlight = await getBook(book.id)
    expect(inFlight?.uploading).toBe(true)
    expect(inFlight?.uploadJob).toBeDefined()
    expect(inFlight?.uploadJob?.voiceId).toBe(voiceId('en_US-hfc_female-medium'))
    expect(inFlight?.uploadJob?.mode).toBe('initial')
    expect(inFlight?.uploadJob?.total).toBe(3)
    expect(inFlight?.uploadJob?.done).toBe(0)
    uploadManager.cancel()
    // Resolve the in-flight synth so cancel() can finalize.
    await act(async () => {
      resolveFirst?.()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('idle'))
  })

  it('bumps persisted uploadJob.done per-paragraph (visible progress after eviction)', async () => {
    const book = { ...makeBook('Per-Para Progress'), uploading: true }
    await putBook(book)
    const gates: Array<() => void> = []
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() =>
            res({ audio: new Blob(['x']), synthMs: 50, durationSeconds: 1, cacheKey: 'k' }),
          )
        }),
    )
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    // Resolve the first paragraph and let the IDB write settle.
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1))
    act(() => gates[0]?.())
    // patchUploadJob is fire-and-forget from onProgress; give it a tick to land.
    await vi.waitFor(async () => {
      const saved = await getBook(book.id)
      expect(saved?.uploadJob?.done).toBe(1)
    })

    // Drain remaining gates so the job completes cleanly.
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(2))
    act(() => gates[1]?.())
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3))
    act(() => gates[2]?.())
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))

    // After completion the uploadJob should be cleared (clearUploadJob runs at end).
    const completed = await getBook(book.id)
    expect(completed?.uploadJob).toBeUndefined()
    expect(completed?.uploading).toBeUndefined()
  })

  it('records the last-attempted paragraph location on uploadJob (debuggability)', async () => {
    const book = { ...makeBook('Location Tracking'), uploading: true }
    await putBook(book)
    const gates: Array<() => void> = []
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' }),
          )
        }),
    )
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    // Resolve the first paragraph so onProgress fires with done=1 + location
    // (persistence happens in onProgress only — see manager.ts for the race
    // rationale).
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1))
    act(() => gates[0]?.())
    await vi.waitFor(async () => {
      const saved = await getBook(book.id)
      expect(saved?.uploadJob?.done).toBe(1)
      expect(saved?.uploadJob?.lastChapterTitle).toBe('Chapter 1')
      expect(saved?.uploadJob?.lastParagraphInChapter).toBe(1)
    })

    // Live UI state also carries the current paragraph's location.
    const state = uploadManager.getState()
    if (state.type === 'synthesizing') {
      expect(state.current?.chapterTitle).toBe('Chapter 1')
    }

    // Drain remaining gates.
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(2))
    act(() => gates[1]?.())
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(3))
    act(() => gates[2]?.())
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('done'))
  })

  it('clears uploadJob on caught error so library does not show Paused for an error-state book', async () => {
    const book = makeBook('Failing Then Error')
    await putBook(book)
    synthMock.mockRejectedValue(new Error('boom'))
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('error'))

    const saved = await getBook(book.id)
    expect(saved).toBeDefined()
    expect(saved?.uploading).toBeUndefined()
    // uploadJob was set at runJob start; the error path must clear it so the
    // library card doesn't show a Resume button for a book in error state.
    expect(saved?.uploadJob).toBeUndefined()
  })

  it('cancel clears both uploading flag and uploadJob', async () => {
    const book = { ...makeBook('Cancellable'), uploading: true }
    await putBook(book)
    // Gated synth so cancel() can finalize at the next paragraph boundary
    // (cooperative abort — never-resolving synth would strand state in
    // 'cancelling' forever).
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' })
        }),
    )
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    // Wait for uploadJob to land before cancelling — runJob writes it inside
    // the try block, so it lags setState by a tick.
    await vi.waitFor(async () => {
      expect((await getBook(book.id))?.uploadJob).toBeDefined()
    })

    uploadManager.cancel()
    await act(async () => {
      resolveFirst?.()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('idle'))
    // The cancel cleanup (clearUploadingFlag + clearUploadJob) is
    // fire-and-forget so the wake lock release doesn't slip past a test
    // boundary — poll for the persisted state to settle.
    await vi.waitFor(async () => {
      const saved = await getBook(book.id)
      expect(saved?.uploading).toBeUndefined()
      expect(saved?.uploadJob).toBeUndefined()
    })
  })

  it('cancelForBook is a no-op when no job is active', async () => {
    const result = await uploadManager.cancelForBook(bookId('any-id'))
    expect(result).toEqual({ type: 'no-op' })
  })

  it('cancelForBook cancels an active job for the same book and awaits idle', async () => {
    const book = { ...makeBook('Cancellable For Book'), uploading: true }
    await putBook(book)
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' })
        }),
    )
    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(async () => {
      expect((await getBook(book.id))?.uploadJob).toBeDefined()
    })

    const resultPromise = uploadManager.cancelForBook(book.id)
    await act(async () => {
      resolveFirst?.()
    })
    const result = await resultPromise
    expect(result).toEqual({ type: 'cancelled' })
    expect(uploadManager.getState().type).toBe('idle')
  })

  it('cancelForBook is blocked when a job is active for another book', async () => {
    const active = { ...makeBook('Active Other'), uploading: true }
    const other = makeBook('Target Other')
    await putBook(active)
    await putBook(other)
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' })
        }),
    )
    uploadManager.startJob({
      book: active,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('synthesizing'))

    const result = await uploadManager.cancelForBook(other.id)
    expect(result).toEqual({ type: 'blocked', activeBookTitle: 'Active Other' })
    // The active job is untouched — caller must cancel it explicitly.
    expect(uploadManager.getState().type).toBe('synthesizing')

    // Tear down so the next test starts from idle.
    uploadManager.cancel()
    await act(async () => {
      resolveFirst?.()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('idle'))
  })

  it('recovers (pause → resume) when the tab was hidden longer than the lock threshold (Issue 4)', async () => {
    const book = { ...makeBook('Locky'), uploading: true }
    await putBook(book)
    // Gate each synth so the job stays mid-synth while we toggle visibility.
    const gates: Array<() => void> = []
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' }),
          )
        }),
    )
    const setVisible = (v: boolean) =>
      Object.defineProperty(document, 'visibilityState', {
        value: v ? 'visible' : 'hidden',
        configurable: true,
      })
    const dispatch = () => document.dispatchEvent(new Event('visibilitychange'))

    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('synthesizing'))
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1))
    expect(uploadManager.isRecovering()).toBe(false)

    // Hide → fast-forward past LOCK_RECOVERY_THRESHOLD_MS (5s) → visible.
    // Recovery uses Date.now() to compute hide duration, so we advance the
    // system clock rather than fake-timer ticks.
    setVisible(false)
    dispatch()
    vi.setSystemTime(Date.now() + 6_000)
    setVisible(true)
    dispatch()

    // Recovery sets the flag immediately, then runs pause → wait → resume.
    await vi.waitFor(() => expect(uploadManager.isRecovering()).toBe(true))

    // Resolve the in-flight synth so the abort is observed + the manager can
    // settle to paused; recovery then calls resume.
    await act(async () => {
      for (const g of gates) g()
    })

    // Recovery completes (flag clears) and the resumed job finishes via the
    // cache (already-cached paragraphs fast-forward; the mock bypasses cache
    // lookup so the loop runs each synth again — resolve any stragglers).
    await vi.waitFor(() => expect(uploadManager.isRecovering()).toBe(false))
    await act(async () => {
      for (const g of gates) g()
    })
    await vi.waitFor(() => {
      const t = uploadManager.getState().type
      return t === 'done' || t === 'idle' || t === 'synthesizing'
    })
    // Recovery completed and we did NOT strand the manager in an error.
    expect(uploadManager.getState().type).not.toBe('error')
    expect(uploadManager.isRecovering()).toBe(false)
    vi.useRealTimers()
  })

  it('does NOT recover when the tab was hidden briefly (tab switch)', async () => {
    const book = { ...makeBook('Tabby'), uploading: true }
    await putBook(book)
    const gates: Array<() => void> = []
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' }),
          )
        }),
    )
    const setVisible = (v: boolean) =>
      Object.defineProperty(document, 'visibilityState', {
        value: v ? 'visible' : 'hidden',
        configurable: true,
      })
    const dispatch = () => document.dispatchEvent(new Event('visibilitychange'))

    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('synthesizing'))

    // Hide → fast-forward only 2s (under the 5s threshold) → visible.
    setVisible(false)
    dispatch()
    vi.setSystemTime(Date.now() + 2_000)
    setVisible(true)
    dispatch()

    // Allow the visibility handler to fire — no recovery should start.
    await new Promise((r) => setTimeout(r, 10))
    expect(uploadManager.isRecovering()).toBe(false)
    expect(uploadManager.getState().type).toBe('synthesizing')

    // Cleanup.
    uploadManager.cancel()
    await act(async () => {
      for (const g of gates) g()
    })
    await vi.waitFor(() => expect(uploadManager.getState().type).toBe('idle'))
    vi.useRealTimers()
  })
})

describe('useUploadState', () => {
  it('re-renders when the manager state changes', async () => {
    const book = makeBook()
    const { result } = renderHook(() => useUploadState())
    expect(result.current.type).toBe('idle')

    uploadManager.startJob({
      book,
      chapters: makeChapters(),
      voiceId: voiceId('en_US-hfc_female-medium'),
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(result.current.type).toBe('done'))
  })
})
