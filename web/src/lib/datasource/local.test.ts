import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioCacheRecord, Book, BookId, Chapter } from '../../types'
import { newBookId, newChapterId, voiceId } from '../../types'
import type { AppliedProcessing } from '../ai/types'
import { audioCacheKey } from '../audio-cache'
import { putSegment } from '../audio-segment-cache'
import { parseManifest } from '../backup'
import { type BookAudio, putBookAudio } from '../book-audio'
import { _clearDBForTests, _resetDBForTests, putAudioCacheEntry, putBookFile } from '../db'
import type { ParseResult } from '../parse/types'
import { bookTransformManager } from '../transform/manager'
import { uploadManager } from '../upload/manager'
import { localDatasource, localSynthPipeline } from './local'

const synthMock =
  vi.fn<
    (
      ...args: unknown[]
    ) => Promise<{ audio?: Blob; synthMs: number; durationSeconds: number; cacheKey: string }>
  >()
const isStoredMock = vi.fn<(...args: unknown[]) => Promise<boolean>>()
const downloadMock = vi.fn<(...args: unknown[]) => Promise<void>>()
const parseMock = vi.fn<(file: File) => Promise<ParseResult>>()

vi.mock('../tts/client', () => ({
  ttsClient: {
    isStored: (...args: unknown[]) => isStoredMock(...args),
    download: (...args: unknown[]) => downloadMock(...args),
    synthesize: (...args: unknown[]) => synthMock(...args),
    listVoices: async () => [],
    remove: async () => {},
  },
}))

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
    async isStored(id: unknown) {
      // @ts-expect-error — same as above
      return this.voiceEngine.isStored(id)
    }
    async download(id: unknown, onProgress?: (f: number) => void) {
      // @ts-expect-error — same as above
      return this.voiceEngine.download(id, onProgress)
    }
  },
}))

vi.mock('../tts/pool-size', () => ({
  preferredPoolSize: () => 1,
}))

vi.mock('../parse/client', () => ({
  parseInWorker: (file: File) => parseMock(file),
}))

const TEST_VOICE = voiceId('en_US-hfc_female-medium')

function makeBook(title = 'Test Book', overrides: Partial<Book> = {}): Book {
  const now = Date.now()
  return {
    id: newBookId(),
    title,
    format: 'txt',
    chapterCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeChapters(bookId: BookId): Chapter[] {
  return [
    {
      id: newChapterId(),
      bookId,
      index: 0,
      title: 'Chapter 1',
      paragraphs: ['Hello world.', 'Second paragraph.', '   ', 'Third.'],
    },
  ]
}

function makeAudioCacheRecord(key: string, bookId: BookId): AudioCacheRecord {
  const now = Date.now()
  return {
    key,
    blob: new Blob(['wav']),
    bookId,
    sizeBytes: 3,
    synthMs: 1,
    durationSeconds: 1,
    voiceId: TEST_VOICE,
    lastUsed: now,
    createdAt: now,
  }
}

function makeBookAudio(bookId: BookId): BookAudio {
  return {
    bookId,
    blob: new Blob(['m4a']),
    duration: 1,
    paragraphOffsets: [0],
    durations: [1],
    voiceId: TEST_VOICE,
    createdAt: Date.now(),
  }
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
  isStoredMock.mockReset().mockResolvedValue(true)
  downloadMock.mockReset().mockResolvedValue(undefined)
  parseMock.mockReset()
  synthMock.mockResolvedValue({
    audio: new Blob(['x']),
    synthMs: 100,
    durationSeconds: 1,
    cacheKey: 'k',
  })
  uploadManager._resetForTests()
  bookTransformManager._resetForTests()
})

afterEach(() => {
  uploadManager._resetForTests()
  bookTransformManager._resetForTests()
})

describe('localDatasource — library parity', () => {
  it('round-trips put + list + get + most-recent through the facade', async () => {
    const older = makeBook('Older')
    const newer = makeBook('Newer', { updatedAt: older.updatedAt + 1000 })
    await localDatasource.putBook(older)
    await localDatasource.putBook(newer)

    expect(await localDatasource.getAllBooks()).toEqual([newer, older])
    expect(await localDatasource.getBook(older.id)).toEqual(older)
    expect(await localDatasource.getMostRecentBook()).toEqual(newer)
    expect(await localDatasource.getBook(newBookId())).toBeUndefined()
  })

  it('deleteBookCascade removes book, chapters, file, cached audio, and whole-book audio', async () => {
    const book = makeBook('Cascade')
    const chapters = makeChapters(book.id)
    await localDatasource.putBook(book)
    await localDatasource.putChapters(chapters)
    await putBookFile({
      bookId: book.id,
      blob: new Blob(['raw']),
      name: 'cascade.txt',
      type: 'text/plain',
      size: 3,
    })
    const key = await audioCacheKey(TEST_VOICE, 'Hello world.')
    await putAudioCacheEntry(makeAudioCacheRecord(key, book.id))
    await putBookAudio(makeBookAudio(book.id))

    await localDatasource.deleteBookCascade(book.id)

    expect(await localDatasource.getBook(book.id)).toBeUndefined()
    expect(await localDatasource.getChaptersByBook(book.id)).toEqual([])
    expect(await localDatasource.getBookFile(book.id)).toBeUndefined()
    expect(await localDatasource.getAudioCacheKeysByBook(book.id)).toEqual([])
    expect(await localDatasource.getBookAudio(book.id)).toBeUndefined()
  })

  it('updateBookProgress sets position + fraction and bumps updatedAt', async () => {
    const book = makeBook('Progress', { createdAt: 1000, updatedAt: 1000 })
    await localDatasource.putBook(book)

    await localDatasource.updateBookProgress(book.id, { chapterIndex: 2, paragraphIndex: 5 }, 0.42)

    const saved = await localDatasource.getBook(book.id)
    expect(saved?.position).toEqual({ chapterIndex: 2, paragraphIndex: 5 })
    expect(saved?.progressFraction).toBe(0.42)
    expect(saved?.updatedAt).toBeGreaterThan(1000)
  })

  it('updateBookProcessing sets then clears the applied-processing record', async () => {
    const book = makeBook('Processed')
    await localDatasource.putBook(book)
    const processing: AppliedProcessing = { appliedAt: 1234, ops: [] }

    await localDatasource.updateBookProcessing(book.id, processing)
    expect((await localDatasource.getBook(book.id))?.processing).toEqual(processing)

    await localDatasource.updateBookProcessing(book.id, undefined)
    expect((await localDatasource.getBook(book.id))?.processing).toBeUndefined()
  })

  it('updateParagraph overwrites one paragraph and returns the updated chapter', async () => {
    const book = makeBook('Edit')
    const chapterId = newChapterId()
    await localDatasource.putChapters([
      {
        id: chapterId,
        bookId: book.id,
        index: 0,
        title: 'Chapter 1',
        paragraphs: ['Hello world.', 'Second paragraph.', '   ', 'Third.'],
      },
    ])

    const updated = await localDatasource.updateParagraph(chapterId, 1, 'Edited.')
    expect(updated?.paragraphs[1]).toBe('Edited.')
    expect(await localDatasource.getChaptersByBook(book.id)).toEqual([updated])
    expect(await localDatasource.updateParagraph(chapterId, 99, 'Nope')).toBeUndefined()
  })

  it('replaceBookChapters swaps the chapter set for the book', async () => {
    const book = makeBook('Outline')
    await localDatasource.putChapters(makeChapters(book.id))
    const replacement: Chapter[] = [
      { id: newChapterId(), bookId: book.id, index: 0, title: 'New', paragraphs: ['One.', 'Two.'] },
    ]

    await localDatasource.replaceBookChapters(book.id, replacement)

    expect(await localDatasource.getChaptersByBook(book.id)).toEqual(replacement)
  })

  it('getBookFile returns the stored original upload', async () => {
    const book = makeBook('Original')
    await putBookFile({
      bookId: book.id,
      blob: new Blob(['bytes']),
      name: 'original.epub',
      type: 'application/epub+zip',
      size: 5,
    })

    const stored = await localDatasource.getBookFile(book.id)
    expect(stored?.name).toBe('original.epub')
    expect(stored?.size).toBe(5)
  })

  it('getCachedParagraphIds reports cached paragraphs for the voice only', async () => {
    const book = makeBook('Probe')
    const chapters = makeChapters(book.id)
    await localDatasource.putBook(book)
    await localDatasource.putChapters(chapters)
    const key = await audioCacheKey(TEST_VOICE, 'Hello world.')
    await putAudioCacheEntry(makeAudioCacheRecord(key, book.id))

    const cached = await localDatasource.getCachedParagraphIds(book.id, TEST_VOICE, chapters)
    expect(cached).toEqual(new Set([`${chapters[0]?.id}:0`]))

    const otherVoice = await localDatasource.getCachedParagraphIds(
      book.id,
      voiceId('en_US-amy-medium'),
      chapters,
    )
    expect(otherVoice.size).toBe(0)
  })

  it('audio invalidation: keys-by-book, deleteAudioCacheKeys count, deleteBookAudio', async () => {
    const book = makeBook('Invalidate')
    await localDatasource.putBook(book)
    const key = await audioCacheKey(TEST_VOICE, 'Hello world.')
    await putAudioCacheEntry(makeAudioCacheRecord(key, book.id))
    await putBookAudio(makeBookAudio(book.id))

    expect(await localDatasource.getAudioCacheKeysByBook(book.id)).toEqual([key])
    expect(await localDatasource.deleteAudioCacheKeys([key])).toBe(1)
    expect(await localDatasource.getAudioCacheKeysByBook(book.id)).toEqual([])

    expect(await localDatasource.getBookAudio(book.id)).toBeDefined()
    await localDatasource.deleteBookAudio(book.id)
    expect(await localDatasource.getBookAudio(book.id)).toBeUndefined()
  })
})

describe('localDatasource — storage management + backup parity', () => {
  it('audio-cache size, evict-to-budget, and clear report counts through the facade', async () => {
    const book = makeBook('Storage')
    await localDatasource.putBook(book)
    const key = await audioCacheKey(TEST_VOICE, 'Hello world.')
    await putAudioCacheEntry(makeAudioCacheRecord(key, book.id))
    expect(await localDatasource.getAudioCacheSize()).toBe(3)

    expect(await localDatasource.evictAudioCacheToBudget(2)).toBe(1)
    expect(await localDatasource.getAudioCacheSize()).toBe(0)

    const otherKey = await audioCacheKey(TEST_VOICE, 'Second paragraph.')
    await putAudioCacheEntry(makeAudioCacheRecord(otherKey, book.id))
    expect(await localDatasource.clearAudioCache()).toBe(1)
    expect(await localDatasource.getAudioCacheSize()).toBe(0)
  })

  it('clearSegmentCache empties the segment store', async () => {
    await putSegment('seg-key', new Blob(['seg']), 1, { voiceId: TEST_VOICE })
    expect(await localDatasource.clearSegmentCache()).toBe(1)
    expect(await localDatasource.clearSegmentCache()).toBe(0)
  })

  it('clearAllStores wipes every datasource-owned store', async () => {
    const book = makeBook('Wipe')
    await localDatasource.putBook(book)
    await putAudioCacheEntry(
      makeAudioCacheRecord(await audioCacheKey(TEST_VOICE, 'Hello world.'), book.id),
    )
    await putSegment('seg-key', new Blob(['seg']), 1, { voiceId: TEST_VOICE })

    await localDatasource.clearAllStores()

    expect(await localDatasource.getAllBooks()).toEqual([])
    expect(await localDatasource.getAudioCacheSize()).toBe(0)
    expect(await localDatasource.clearSegmentCache()).toBe(0)
  })

  it('exportBackup then importBackup round-trips: manifest carries the book, re-import skips it', async () => {
    const book = makeBook('Backup')
    await localDatasource.putBook(book)
    await localDatasource.putChapters(makeChapters(book.id))

    const blob = await localDatasource.exportBackup()
    const manifest = parseManifest(await blob.text())
    expect(manifest.books.map((b) => b.id)).toEqual([book.id])

    const report = await localDatasource.importBackup(blob)
    expect(report.booksSkipped).toBe(1)
    expect(report.booksImported).toBe(0)
    expect(await localDatasource.getBook(book.id)).toEqual(book)
  })
})

describe('localSynthPipeline — parity', () => {
  it('ingestBook persists a book with uploading=true plus chapters + original file', async () => {
    parseMock.mockResolvedValue({
      title: 'Mocked Book',
      chapters: [{ title: 'Chapter 1', paragraphs: ['Hello world.', 'Second paragraph.'] }],
    })

    const result = await localSynthPipeline.ingestBook(
      new File(['irrelevant'], 'mocked.txt', { type: 'text/plain' }),
    )

    expect(result.book.uploading).toBe(true)
    expect(result.book.title).toBe('Mocked Book')
    expect(await localDatasource.getBook(result.book.id)).toEqual(result.book)
    expect(await localDatasource.getChaptersByBook(result.book.id)).toEqual(result.chapters)
    expect((await localDatasource.getBookFile(result.book.id))?.name).toBe('mocked.txt')
  })

  it('ingestBook rejects unsupported files', async () => {
    await expect(localSynthPipeline.ingestBook(new File(['x'], 'book.xyz'))).rejects.toThrow(
      /Unsupported file type/,
    )
  })

  it('startJob persists the resumable uploadJob from the first tick (G24)', async () => {
    const book = makeBook('G24', { uploading: true })
    await localDatasource.putBook(book)
    let resolveFirst: (() => void) | undefined
    synthMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' })
        }),
    )

    localSynthPipeline.startJob({
      book,
      chapters: makeChapters(book.id),
      voiceId: TEST_VOICE,
      cleaning: idleCleaning,
    })
    expect(localSynthPipeline.isActive()).toBe(true)
    expect(localSynthPipeline.canPause()).toBe(true)
    expect(localSynthPipeline.isRecovering()).toBe(false)

    await vi.waitFor(async () => {
      const saved = await localDatasource.getBook(book.id)
      expect(saved?.uploadJob).toBeDefined()
    })
    const inFlight = await localDatasource.getBook(book.id)
    expect(inFlight?.uploading).toBe(true)
    expect(inFlight?.uploadJob?.voiceId).toBe(TEST_VOICE)
    expect(inFlight?.uploadJob?.mode).toBe('initial')
    expect(inFlight?.uploadJob?.total).toBe(3)
    expect(inFlight?.uploadJob?.done).toBe(0)

    localSynthPipeline.cancel()
    await resolveFirst?.()
    await vi.waitFor(() => expect(localSynthPipeline.getState().type).toBe('idle'))
  })

  it('runs a job to done through the pipeline and clears uploading + uploadJob', async () => {
    const book = makeBook('Done', { uploading: true })
    await localDatasource.putBook(book)

    localSynthPipeline.startJob({
      book,
      chapters: makeChapters(book.id),
      voiceId: TEST_VOICE,
      cleaning: idleCleaning,
    })
    await vi.waitFor(() => expect(localSynthPipeline.getState().type).toBe('done'))
    expect(synthMock).toHaveBeenCalledTimes(3)

    const saved = await localDatasource.getBook(book.id)
    expect(saved?.uploading).toBeUndefined()
    expect(saved?.uploadJob).toBeUndefined()
  })

  it('reparseChapters recovers pristine chapters with stable ids from the stored original', async () => {
    parseMock.mockResolvedValue({
      title: 'Mocked Book',
      chapters: [{ title: 'Chapter 1', paragraphs: ['Pristine one.', 'Pristine two.'] }],
    })
    const book = makeBook('Reparse')
    await localDatasource.putBook(book)
    const chapterId = newChapterId()
    await localDatasource.putChapters([
      {
        id: chapterId,
        bookId: book.id,
        index: 0,
        title: 'Chapter 1',
        paragraphs: ['Hello world.', 'Second paragraph.', '   ', 'Third.'],
      },
    ])
    await putBookFile({
      bookId: book.id,
      blob: new Blob(['raw']),
      name: 'reparse.txt',
      type: 'text/plain',
      size: 3,
    })
    await localDatasource.updateParagraph(chapterId, 0, 'TRANSFORMED')

    const pristine = await localSynthPipeline.reparseChapters(book.id)
    expect(pristine[0]?.paragraphs[0]).toBe('Pristine one.')
    expect(pristine[0]?.id).toBe(chapterId)
  })

  it('reparseChapters throws when the stored original is gone', async () => {
    const book = makeBook('NoOriginal')
    await localDatasource.putBook(book)
    await expect(localSynthPipeline.reparseChapters(book.id)).rejects.toThrow(/no longer available/)
  })

  it('delegates the transform surface to the singleton manager', () => {
    expect(localSynthPipeline.getTransformState().type).toBe('idle')
    let notified = 0
    const unsub = localSynthPipeline.subscribeTransform(() => {
      notified++
    })
    bookTransformManager._resetForTests()
    unsub()
    expect(notified).toBe(1)
  })
})
