import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, Chapter } from '../../types'
import { newBookId, newChapterId, voiceId } from '../../types'
import { _clearDBForTests, _resetDBForTests, getBook, putBook } from '../db'
import { type JobState, uploadManager } from './manager'
import { useUploadState } from './useUpload'

const synthMock = vi.fn<(...args: unknown[]) => Promise<{ audio: Blob; synthMs: number }>>()
const isStoredMock = vi.fn<(...args: unknown[]) => Promise<boolean>>()
const downloadMock = vi.fn<(...args: unknown[]) => Promise<void>>()

vi.mock('../tts/client', () => ({
  ttsClient: {
    isStored: (...args: unknown[]) => isStoredMock(...args),
    download: (...args: unknown[]) => downloadMock(...args),
    synthesize: (...args: unknown[]) => synthMock(...args),
    listVoices: async () => [],
    remove: async () => {},
  },
}))

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

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  synthMock.mockReset()
  isStoredMock.mockReset()
  downloadMock.mockReset()
  isStoredMock.mockResolvedValue(true)
  synthMock.mockResolvedValue({ audio: new Blob(['x']), synthMs: 100 })
  uploadManager._resetForTests()
})

afterEach(() => {
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
  })

  it('tracks synthesizedParagraphIds as paragraphs complete', async () => {
    const book = makeBook()
    const chapters = makeChapters()
    // Gate each synth call so we can observe intermediate states.
    const gates: Array<() => void> = []
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() => res({ audio: new Blob(['x']), synthMs: 50 }))
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

  it('cancel aborts and returns to idle', async () => {
    const book = makeBook()
    // Gate synth so the job stays in-flight on the first paragraph.
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () => res({ audio: new Blob(['x']), synthMs: 1 })
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
    expect((state as Extract<JobState, { type: 'error' }>).message).toBe('worker exploded')
  })

  it('initial mode cascade-deletes the book on failure (fresh-upload contract)', async () => {
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
    expect(await getBook(book.id)).toBeUndefined()
    expect(uploadManager.canRetry()).toBe(false)
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
          gates.push(() => res({ audio: new Blob(['x']), synthMs: 50 }))
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
