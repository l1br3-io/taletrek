import { describe, expect, it, type Mock, vi } from 'vitest'
import type { Chapter, VoiceId } from '../../types'
import { bookId, chapterId } from '../../types'
import {
  type BookDto,
  type ChapterDto,
  createServerDatasource,
  createServerSynthPipeline,
  HostedModeUnavailableError,
  ServerApiError,
  serverPlaybackEngine,
} from './server'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function dto(overrides: Partial<BookDto> = {}): BookDto {
  return {
    id: 'b1',
    title: 'Wizards Abroad',
    author: 'A. Author',
    sourceFormat: 'epub',
    voiceId: 'en_US-lessac',
    audioPresent: false,
    chapterCount: 12,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    position: null,
    ...overrides,
  }
}

function chapterDto(overrides: Partial<ChapterDto> = {}): ChapterDto {
  return {
    id: 'ch_b1_0',
    bookId: 'b1',
    idx: 0,
    title: 'Chapter One',
    paragraphs: ['Hello world.', 'Second ¶.'],
    ...overrides,
  }
}

/** A fetch mock + datasource pair wired together. */
function setup(): { ds: ReturnType<typeof createServerDatasource>; fetchMock: Mock } {
  const fetchMock = vi.fn<typeof fetch>()
  return { ds: createServerDatasource({ fetchImpl: fetchMock as typeof fetch }), fetchMock }
}

// ---------------------------------------------------------------------------
// books
// ---------------------------------------------------------------------------

describe('ServerDatasource books', () => {
  it('getAllBooks maps BookDto → Book (brand, format, position, fraction)', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(
      json(200, [
        dto({
          position: { chapterIndex: 1, paragraphIndex: 3, progressFraction: 0.42 },
        }),
      ]),
    )

    const books = await ds.getAllBooks()
    expect(books).toEqual([
      {
        id: bookId('b1'),
        title: 'Wizards Abroad',
        format: 'epub',
        chapterCount: 12,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
        position: { chapterIndex: 1, paragraphIndex: 3 },
        progressFraction: 0.42,
      },
    ])
    expect(fetchMock).toHaveBeenCalledWith('/api/books', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
  })

  it('unknown sourceFormat coerces to txt (G28); missing position stays undefined', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(200, [dto({ sourceFormat: 'unknown', position: null })]))
    const [book] = await ds.getAllBooks()
    expect(book?.format).toBe('txt')
    expect(book?.position).toBeUndefined()
    expect(book?.progressFraction).toBeUndefined()
  })

  it('malformed position extras are dropped defensively', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(
      json(200, [dto({ position: { chapterIndex: 'nope', paragraphIndex: 2 } })]),
    )
    const [book] = await ds.getAllBooks()
    expect(book?.position).toBeUndefined()
  })

  it('getBook returns the mapped book', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(200, dto()))
    expect(await ds.getBook(bookId('b1'))).toMatchObject({
      id: bookId('b1'),
      title: 'Wizards Abroad',
    })
  })

  it('getBook 404 → undefined (not-found state)', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(404, 'book not found'))
    expect(await ds.getBook(bookId('missing'))).toBeUndefined()
  })

  it('getBook 401 mid-session → ServerApiError.isUnauthorized (surface re-login)', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(401, 'unauthorized'))
    const err = await ds.getBook(bookId('b1')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerApiError)
    expect((err as ServerApiError).isUnauthorized).toBe(true)
  })

  it('getBook network failure → ServerApiError without status', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const err = await ds.getBook(bookId('b1')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerApiError)
    expect((err as ServerApiError).status).toBeUndefined()
  })

  it('getMostRecentBook → first (newest-updated) book; undefined when empty', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(200, [dto({ id: 'newest' }), dto({ id: 'older' })]))
    expect(await ds.getMostRecentBook()).toMatchObject({ id: bookId('newest') })

    const empty = setup()
    empty.fetchMock.mockResolvedValue(json(200, []))
    expect(await empty.ds.getMostRecentBook()).toBeUndefined()
  })

  it('putBook throws HostedModeUnavailableError (no rename endpoint in v1)', async () => {
    const { ds } = setup()
    await expect(
      ds.putBook({ id: bookId('b1') } as Parameters<LibraryDs['putBook']>[0]),
    ).rejects.toBeInstanceOf(HostedModeUnavailableError)
  })
})

// ---------------------------------------------------------------------------
// delete + progress
// ---------------------------------------------------------------------------

describe('ServerDatasource delete + progress', () => {
  it('deleteBookCascade issues DELETE and resolves on 204', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(ds.deleteBookCascade(bookId('b1'))).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/books/b1', {
      credentials: 'same-origin',
      cache: 'no-store',
      method: 'DELETE',
    })
  })

  it('deleteBookCascade surfaces the 409 synth-running refusal with its message', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(409, 'a synth job is currently running for book b1'))
    const err = await ds.deleteBookCascade(bookId('b1')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerApiError)
    expect((err as ServerApiError).status).toBe(409)
    expect((err as ServerApiError).message).toContain('synth job')
  })

  it('updateBookProgress PATCHes position + progressFraction in one body', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(200, dto()))
    await ds.updateBookProgress(bookId('b1'), { chapterIndex: 2, paragraphIndex: 5 }, 0.75)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/books/b1/progress')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({
      chapterIndex: 2,
      paragraphIndex: 5,
      progressFraction: 0.75,
    })
  })

  it('updateBookProgress 404 resolves silently (mirrors the local no-op)', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(404, 'book not found'))
    await expect(
      ds.updateBookProgress(bookId('gone'), { chapterIndex: 0, paragraphIndex: 0 }, 0),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// chapters
// ---------------------------------------------------------------------------

describe('ServerDatasource chapters', () => {
  it('getChaptersByBook maps the T9 wire shape → SPA Chapter', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(
      json(200, [chapterDto(), chapterDto({ id: 'ch_b1_1', idx: 1, title: 'Chapter Two' })]),
    )
    const chapters: Chapter[] = await ds.getChaptersByBook(bookId('b1'))
    expect(chapters).toEqual([
      {
        id: chapterId('ch_b1_0'),
        bookId: bookId('b1'),
        index: 0,
        title: 'Chapter One',
        paragraphs: ['Hello world.', 'Second ¶.'],
      },
      {
        id: chapterId('ch_b1_1'),
        bookId: bookId('b1'),
        index: 1,
        title: 'Chapter Two',
        paragraphs: ['Hello world.', 'Second ¶.'],
      },
    ])
  })

  it('getChaptersByBook 404 → [] (local semantics)', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(404, 'book not found'))
    expect(await ds.getChaptersByBook(bookId('missing'))).toEqual([])
  })

  it('chapter writes are unsupported in hosted mode', async () => {
    const { ds } = setup()
    await expect(ds.putChapters([])).rejects.toBeInstanceOf(HostedModeUnavailableError)
    await expect(ds.replaceBookChapters(bookId('b1'), [])).rejects.toBeInstanceOf(
      HostedModeUnavailableError,
    )
    await expect(ds.updateParagraph(chapterId('ch_b1_0'), 0, 'x')).rejects.toBeInstanceOf(
      HostedModeUnavailableError,
    )
  })
})

// ---------------------------------------------------------------------------
// audio probing + local-only surfaces
// ---------------------------------------------------------------------------

describe('ServerDatasource audio probing', () => {
  const chapters: Chapter[] = [
    {
      id: chapterId('ch_b1_0'),
      bookId: bookId('b1'),
      index: 0,
      title: 'One',
      paragraphs: ['Audible one.', '', 'Audible two.'],
    },
  ]

  it('audioPresent + matching voice → every non-empty paragraph id', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(200, dto({ audioPresent: true, voiceId: 'en_US-lessac' })))
    const ids = await ds.getCachedParagraphIds(bookId('b1'), 'en_US-lessac' as VoiceId, chapters)
    expect(ids).toEqual(new Set(['ch_b1_0:0', 'ch_b1_0:2']))
  })

  it('voice mismatch → empty set (audio exists under another voice)', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(200, dto({ audioPresent: true, voiceId: 'en_US-amy' })))
    const ids = await ds.getCachedParagraphIds(bookId('b1'), 'en_US-lessac' as VoiceId, chapters)
    expect(ids.size).toBe(0)
  })

  it('audioPresent=false (pre/mid-synth) → empty set', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(200, dto()))
    const ids = await ds.getCachedParagraphIds(bookId('b1'), 'en_US-lessac' as VoiceId, chapters)
    expect(ids.size).toBe(0)
  })

  it('missing book → empty set', async () => {
    const { ds, fetchMock } = setup()
    fetchMock.mockResolvedValue(json(404, 'book not found'))
    const ids = await ds.getCachedParagraphIds(bookId('gone'), 'en_US-lessac' as VoiceId, chapters)
    expect(ids.size).toBe(0)
  })
})

describe('ServerDatasource local-only surfaces', () => {
  it('local audio-cache/store ops are no-ops that never hit the network', async () => {
    const { ds, fetchMock } = setup()
    await expect(ds.getAudioCacheKeysByBook(bookId('b1'))).resolves.toEqual([])
    await expect(ds.deleteAudioCacheKeys(['k'])).resolves.toBe(0)
    await expect(ds.deleteBookAudio(bookId('b1'))).resolves.toBeUndefined()
    await expect(ds.getAudioCacheSize()).resolves.toBe(0)
    await expect(ds.clearAudioCache()).resolves.toBe(0)
    await expect(ds.clearSegmentCache()).resolves.toBe(0)
    await expect(ds.evictAudioCacheToBudget(1024)).resolves.toBe(0)
    await expect(ds.clearAllStores()).resolves.toBeUndefined()
    await expect(ds.getBookAudio(bookId('b1'))).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('original-file access, processing record, and backup are unsupported', async () => {
    const { ds } = setup()
    await expect(ds.getBookFile(bookId('b1'))).rejects.toBeInstanceOf(HostedModeUnavailableError)
    await expect(ds.updateBookProcessing(bookId('b1'), undefined)).rejects.toBeInstanceOf(
      HostedModeUnavailableError,
    )
    await expect(ds.exportBackup()).rejects.toBeInstanceOf(HostedModeUnavailableError)
    await expect(ds.importBackup(new Blob([]))).rejects.toBeInstanceOf(HostedModeUnavailableError)
  })
})

// ---------------------------------------------------------------------------
// synth pipeline stub (T14 fills it in)
// ---------------------------------------------------------------------------

describe('serverSynthPipeline stub', () => {
  it('passive queries keep mount-path subscribers inert', async () => {
    const p = createServerSynthPipeline()
    expect(p.getState()).toEqual({ type: 'idle' })
    expect(p.getState()).toBe(p.getState()) // reference-stable for useSyncExternalStore
    expect(p.getTransformState()).toEqual({ type: 'idle' })
    expect(p.getTransformState()).toBe(p.getTransformState())
    expect(p.isActive()).toBe(false)
    expect(p.canPause()).toBe(false)
    expect(p.canRetry()).toBe(false)
    expect(p.isRecovering()).toBe(false)
    const unsub = p.subscribe(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('delete guards answer no-op so hosted delete still works', async () => {
    const p = createServerSynthPipeline()
    expect(await p.cancelForBook(bookId('b1'))).toEqual({ type: 'no-op' })
    expect(await p.cancelTransformForBook(bookId('b1'))).toEqual({ type: 'no-op' })
  })

  it('operations throw HostedModeUnavailableError', async () => {
    const p = createServerSynthPipeline()
    await expect(p.ingestBook(new File([], 'b.epub'))).rejects.toBeInstanceOf(
      HostedModeUnavailableError,
    )
    expect(() => p.startJob({} as Parameters<typeof p.startJob>[0])).toThrow(
      HostedModeUnavailableError,
    )
    await expect(p.resume(bookId('b1'))).rejects.toBeInstanceOf(HostedModeUnavailableError)
    await expect(
      p.startTransform({} as Parameters<typeof p.startTransform>[0], {
        ai: {} as Parameters<typeof p.startTransform>[1]['ai'],
        defs: [],
        synthEnabled: true,
      }),
    ).rejects.toBeInstanceOf(HostedModeUnavailableError)
    await expect(p.reparseChapters(bookId('b1'))).rejects.toBeInstanceOf(HostedModeUnavailableError)
  })
})

describe('serverPlaybackEngine (interim T13)', () => {
  it('refuses on-device synthesis + voice downloads; answers queries passively', async () => {
    await expect(serverPlaybackEngine.synthesize({} as never)).rejects.toBeInstanceOf(
      HostedModeUnavailableError,
    )
    await expect(serverPlaybackEngine.download('v' as never)).rejects.toBeInstanceOf(
      HostedModeUnavailableError,
    )
    await expect(serverPlaybackEngine.isStored('v' as never)).resolves.toBe(false)
    await expect(serverPlaybackEngine.listVoices()).resolves.toEqual([])
    await expect(serverPlaybackEngine.remove('v' as never)).resolves.toBeUndefined()
    await expect(serverPlaybackEngine.clearAllStored()).resolves.toBeUndefined()
  })
})

/** Local type alias for parameter-position typing in tests. */
type LibraryDs = ReturnType<typeof createServerDatasource>
