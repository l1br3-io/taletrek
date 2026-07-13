import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearDBForTests, _resetDBForTests } from '../lib/db'
import type { Book, Chapter } from '../types'
import { newBookId, newChapterId, voiceId } from '../types'
import { useBookUpload } from './useBookUpload'

const ingestBookMock = vi.fn()
const synthMock = vi.fn()
const isStoredMock = vi.fn()
const downloadMock = vi.fn()

vi.mock('../lib/ingest', () => ({
  ingestBook: (file: File) => ingestBookMock(file),
  UnsupportedFileError: class UnsupportedFileError extends Error {
    override readonly name = 'UnsupportedFileError'
  },
}))

vi.mock('../lib/tts/client', () => ({
  ttsClient: {
    isStored: (id: unknown) => isStoredMock(id),
    download: (id: unknown, cb?: (f: number) => void) => downloadMock(id, cb),
    synthesize: (req: unknown) => synthMock(req),
    listVoices: async () => [],
    remove: async () => {},
  },
}))

function makeBook(): Book {
  const now = Date.now()
  return {
    id: newBookId(),
    title: 'Test Book',
    format: 'txt',
    chapterCount: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function makeChapters(): Chapter[] {
  return [
    {
      id: newChapterId(),
      bookId: newBookId(),
      index: 0,
      title: 'Chapter 1',
      paragraphs: ['Hello world.', 'Second paragraph.'],
    },
  ]
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  ingestBookMock.mockReset()
  synthMock.mockReset()
  isStoredMock.mockReset()
  downloadMock.mockReset()
  isStoredMock.mockResolvedValue(true)
  synthMock.mockResolvedValue({ audio: new Blob(['x']), synthMs: 100 })
})

describe('useBookUpload', () => {
  it('parse returns the ingest result without calling onParsed (deferred to synthBook)', async () => {
    const book = makeBook()
    const chapters = makeChapters()
    ingestBookMock.mockResolvedValue({ book, chapters })
    const onNavigate = vi.fn()
    const onParsed = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useBookUpload({
        voiceId: voiceId('en_US-hfc_female-medium'),
        cleaning: {
          enabled: false,
          filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
          pronunciation: [],
        },
        onNavigate,
        onParsed,
      }),
    )

    let parsed: { book: Book; chapters: Chapter[] } | undefined
    await act(async () => {
      parsed = await result.current.parse(new File(['x'], 'test.txt'))
    })

    expect(parsed?.book).toEqual(book)
    expect(onParsed).not.toHaveBeenCalled()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('parse sets error state on failure and returns undefined', async () => {
    ingestBookMock.mockRejectedValue(new Error('Parse failed'))
    const onNavigate = vi.fn()

    const { result } = renderHook(() =>
      useBookUpload({
        voiceId: voiceId('en_US-hfc_female-medium'),
        cleaning: {
          enabled: false,
          filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
          pronunciation: [],
        },
        onNavigate,
      }),
    )

    let parsed: unknown
    await act(async () => {
      parsed = await result.current.parse(new File(['x'], 'bad.txt'))
    })

    expect(parsed).toBeUndefined()
    expect(result.current.upload.type).toBe('error')
  })

  it('synthBook synthesizes, calls onParsed, then navigates on completion', async () => {
    const book = makeBook()
    const chapters = makeChapters()
    const onNavigate = vi.fn()
    const onParsed = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useBookUpload({
        voiceId: voiceId('en_US-hfc_female-medium'),
        cleaning: {
          enabled: false,
          filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
          pronunciation: [],
        },
        onNavigate,
        onParsed,
      }),
    )

    await act(async () => {
      await result.current.synthBook(book, chapters)
    })

    expect(synthMock).toHaveBeenCalledTimes(2)
    expect(onParsed).toHaveBeenCalledOnce()
    expect(onNavigate).toHaveBeenCalledWith(book.id)
  })

  it('skipToReader cancels synth and navigates', async () => {
    const book = makeBook()
    const chapters = makeChapters()
    const onNavigate = vi.fn()

    const { result } = renderHook(() =>
      useBookUpload({
        voiceId: voiceId('en_US-hfc_female-medium'),
        cleaning: {
          enabled: false,
          filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
          pronunciation: [],
        },
        onNavigate,
      }),
    )

    // Start synth (don't await — we want to interrupt it)
    let synthPromise: Promise<void> | undefined
    act(() => {
      synthPromise = result.current.synthBook(book, chapters)
    })

    // Wait for synthesis to start
    await waitFor(() => expect(synthMock).toHaveBeenCalled())

    // Skip
    act(() => {
      result.current.skipToReader()
    })

    expect(onNavigate).toHaveBeenCalledWith(book.id)

    // Let the synth promise resolve
    await act(async () => {
      await synthPromise
    })
  })

  it('skipToReader without a prior parse is a no-op', () => {
    const onNavigate = vi.fn()
    const { result } = renderHook(() =>
      useBookUpload({
        voiceId: voiceId('en_US-hfc_female-medium'),
        cleaning: {
          enabled: false,
          filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
          pronunciation: [],
        },
        onNavigate,
      }),
    )

    act(() => {
      result.current.skipToReader()
    })

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('reset sets state to idle', async () => {
    ingestBookMock.mockRejectedValue(new Error('fail'))
    const onNavigate = vi.fn()

    const { result } = renderHook(() =>
      useBookUpload({
        voiceId: voiceId('en_US-hfc_female-medium'),
        cleaning: {
          enabled: false,
          filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
          pronunciation: [],
        },
        onNavigate,
      }),
    )

    await act(async () => {
      await result.current.parse(new File(['x'], 'bad.txt'))
    })
    expect(result.current.upload.type).toBe('error')

    act(() => {
      result.current.reset()
    })
    expect(result.current.upload.type).toBe('idle')
  })

  it('synthBook triggers voice download when not stored', async () => {
    isStoredMock.mockResolvedValue(false)
    downloadMock.mockResolvedValue(undefined)
    const book = makeBook()
    const chapters = makeChapters()
    const onNavigate = vi.fn()

    const { result } = renderHook(() =>
      useBookUpload({
        voiceId: voiceId('en_US-hfc_female-medium'),
        cleaning: {
          enabled: false,
          filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
          pronunciation: [],
        },
        onNavigate,
      }),
    )

    await act(async () => {
      await result.current.synthBook(book, chapters)
    })

    expect(downloadMock).toHaveBeenCalledOnce()
    expect(onNavigate).toHaveBeenCalledWith(book.id)
  })
})
