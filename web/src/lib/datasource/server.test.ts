import { describe, expect, it, type Mock, vi } from 'vitest'
import type { Chapter, VoiceId } from '../../types'
import { bookId, chapterId } from '../../types'
import type { AiSettings, TransformDefinition, TransformOp } from '../ai/types'
import { readBookBundle } from '../bundle/reader'
import { setSetting } from '../db'
import type { ParseResult } from '../parse/types'
import {
  type BookDto,
  type ChapterDto,
  createServerDatasource,
  createServerSynthPipeline,
  HostedModeUnavailableError,
  type JobDto,
  ServerApiError,
} from './server'

const parseMock = vi.fn<(file: File) => Promise<ParseResult>>()
const engineMock =
  vi.fn<
    (
      paragraphs: string[],
      op: unknown,
      def: unknown,
      onProgress: unknown,
      signal?: AbortSignal,
    ) => Promise<string[]>
  >()

vi.mock('../parse/client', () => ({
  parseInWorker: (file: File) => parseMock(file),
}))

vi.mock('../ai/client', () => ({
  getAiEngineForDef: () => ({
    transform: (...args: Parameters<typeof engineMock>) => engineMock(...args),
  }),
}))

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
// ServerSynthPipeline (T14) — hosted upload → POST → synth → poll
// ---------------------------------------------------------------------------

/** A fetch mock whose routes match exact URL strings or regexes (first wins). */
type Route = [match: RegExp | string, respond: (init?: RequestInit) => unknown | Response]

function router(routes: Route[]): Mock {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    for (const [m, respond] of routes) {
      const hit = typeof m === 'string' ? url === m : m.test(url)
      if (hit) {
        const out = await respond(init)
        return out instanceof Response ? out : json(200, out)
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as unknown as Mock
}

function jobDto(overrides: Partial<JobDto> = {}): JobDto {
  return {
    id: 'j1',
    bookId: 'b1',
    kind: 'synth',
    voice: 'en_US-lessac',
    status: 'succeeded',
    done: 3,
    total: 3,
    error: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...overrides,
  }
}

type JobSpecLike = Parameters<ReturnType<typeof createServerSynthPipeline>['startJob']>[0]

const idleCleaning = {
  enabled: false,
  filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
  pronunciation: [],
}

function specBook(overrides: Partial<JobSpecLike> = {}): JobSpecLike {
  return {
    book: {
      id: bookId('b1'),
      title: 'Wizards Abroad',
      format: 'epub',
      chapterCount: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    chapters: [],
    voiceId: 'en_US-lessac' as VoiceId,
    cleaning: idleCleaning,
    ...overrides,
  }
}

/** Poll `p.getState()` until `cond` holds (bounded, real-timer friendly). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function pipeline(routes: Route[]): ReturnType<typeof createServerSynthPipeline> {
  const mock = router(routes)
  return createServerSynthPipeline({
    fetchImpl: mock as unknown as typeof fetch,
    pollIntervalMs: 1,
  })
}

describe('ServerSynthPipeline ingestBook (parse → text-only bundle → POST)', () => {
  it('parses in the worker, POSTs a multipart bundle, and returns the server-mapped book + derived-id chapters', async () => {
    parseMock.mockResolvedValue({
      title: 'Wizards Abroad',
      chapters: [
        { title: 'Chapter One', paragraphs: ['Hello world.', 'Second ¶.'] },
        { title: 'Chapter Two', paragraphs: ['More.'] },
      ],
    } as ParseResult)

    const posted: { init: RequestInit | undefined }[] = []
    const p = pipeline([
      [
        '/api/books',
        (init) => {
          posted.push({ init })
          // The server keys books by the uploaded bundle's manifest id —
          // mirror that by echoing the id encoded in the multipart filename.
          const bundle = (init?.body as FormData | undefined)?.get('bundle') as File | null
          const id = bundle ? decodeURIComponent(bundle.name).replace(/\.taletrek$/, '') : 'b1'
          return [dto({ id, chapterCount: 2 })]
        },
      ],
    ])

    const result = await p.ingestBook(new File([], 'wizards.epub'))

    // Book is mapped from the 201 BookDto (not a locally-constructed record):
    // id + chapterCount echo the server's upsert row.
    expect(result.book).toMatchObject({ format: 'epub', chapterCount: 2 })
    // Chapters use the server's derived id scheme so later GET /chapters agree.
    expect(result.chapters.map((c) => c.id)).toEqual([
      chapterId(`ch_${result.book.id}_0`),
      chapterId(`ch_${result.book.id}_1`),
    ])
    expect(result.chapters[0]?.paragraphs).toEqual(['Hello world.', 'Second ¶.'])

    // The POST carried a multipart body with a non-empty `bundle` field.
    expect(posted).toHaveLength(1)
    expect(posted[0]?.init?.method).toBe('POST')
    const body = posted[0]?.init?.body
    expect(body).toBeInstanceOf(FormData)
    const bundle = (body as FormData).get('bundle')
    expect(bundle).toBeInstanceOf(Blob)
    expect((bundle as Blob).size).toBeGreaterThan(0)
  })

  it('throws UnsupportedFileError for unrecognized extensions without any fetch', async () => {
    const p = pipeline([])
    await expect(p.ingestBook(new File([], 'book.docx'))).rejects.toThrow(
      'Unsupported file type: book.docx',
    )
  })

  it('surfaces a 413 oversize upload as ServerApiError', async () => {
    parseMock.mockResolvedValue({
      title: 'Big',
      chapters: [{ title: 'C', paragraphs: ['x'] }],
    } as ParseResult)
    const p = pipeline([['/api/books', () => new Response('payload too large', { status: 413 })]])
    const err = await p.ingestBook(new File([], 'big.epub')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerApiError)
    expect((err as ServerApiError).status).toBe(413)
  })
})

describe('ServerSynthPipeline ingestBook — egress cleaning (T15 key parity)', () => {
  /** Paragraphs the default filters visibly change (URL stripped, page
   * number line dropped). */
  const RAW = ['Visit https://example.com for more.', '12', 'Plain text stays.']
  const CLEANED = ['Visit for more.', 'Plain text stays.']

  async function postedParagraphs(): Promise<{ bundle: string[]; result: string[] }> {
    const posted: { init: RequestInit | undefined }[] = []
    const p = pipeline([
      [
        '/api/books',
        (init) => {
          posted.push({ init })
          const bundle = (init?.body as FormData | undefined)?.get('bundle') as File | null
          const id = bundle ? decodeURIComponent(bundle.name).replace(/\.taletrek$/, '') : 'b1'
          return [dto({ id, chapterCount: 1 })]
        },
      ],
    ])
    parseMock.mockResolvedValue({
      title: 'Wizards Abroad',
      chapters: [{ title: 'Chapter One', paragraphs: RAW }],
    } as ParseResult)
    const result = await p.ingestBook(new File([], 'wizards.epub'))
    const form = posted[0]?.init?.body as FormData | undefined
    const file = form?.get('bundle') as File | undefined
    if (!file) throw new Error('no bundle was posted')
    const read = await readBookBundle(new Uint8Array(await file.arrayBuffer()))
    return {
      bundle: read.chapters[0]?.paragraphs ?? [],
      result: result.chapters[0]?.paragraphs ?? [],
    }
  }

  it('applies the default cleaning config when no settings are stored yet', async () => {
    const p = await postedParagraphs()
    expect(p.bundle).toEqual(CLEANED)
    expect(p.result).toEqual(CLEANED)
  })

  it('applies the stored cleaning config to the posted bundle + result chapters', async () => {
    await setSetting('app', {
      cleaning: {
        enabled: true,
        filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
        pronunciation: [],
      },
    })
    const p = await postedParagraphs()
    expect(p.bundle).toEqual(CLEANED)
    expect(p.result).toEqual(CLEANED)
  })

  it('keeps bundle text verbatim when cleaning is disabled in settings', async () => {
    await setSetting('app', {
      cleaning: {
        enabled: false,
        filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
        pronunciation: [],
      },
    })
    const p = await postedParagraphs()
    expect(p.bundle).toEqual(RAW)
    expect(p.result).toEqual(RAW)
  })
})

describe('ServerSynthPipeline startJob (trigger → poll loop)', () => {
  it('happy path: probe → POST synth with the spec voice → poll → done', async () => {
    let polls = 0
    const synthBodies: unknown[] = []
    const p = pipeline([
      [
        '/api/books/b1/synth',
        (init) => {
          synthBodies.push(JSON.parse(String(init?.body)))
          return { jobId: 'j1' }
        },
      ],
      [
        /\/api\/jobs\/j1$/,
        () => {
          polls += 1
          return polls <= 2
            ? jobDto({ status: 'running', done: polls, total: 5 })
            : jobDto({ status: 'succeeded', done: 5, total: 5 })
        },
      ],
      ['/api/books/b1', () => dto({ audioPresent: false })],
    ])

    p.startJob(specBook())
    expect(p.getState().type).toBe('synthesizing')

    await until(() => p.getState().type === 'done')
    expect(synthBodies).toEqual([{ voice: 'en_US-lessac' }])
    expect(polls).toBe(3)
    expect(p.getState()).toMatchObject({ type: 'done', mode: 'initial' })

    p.dismiss()
    expect(p.getState()).toEqual({ type: 'idle' })
  })

  it('feeds running job done/total into the synthesizing state', async () => {
    const seen: Array<{ done: number; total: number }> = []
    let polls = 0
    const p = pipeline([
      ['/api/books/b1/synth', () => ({ jobId: 'j1' })],
      [
        /\/api\/jobs\/j1$/,
        () => {
          polls += 1
          return polls <= 2
            ? jobDto({ status: 'running', done: polls, total: 4 })
            : jobDto({ status: 'succeeded', done: 4, total: 4 })
        },
      ],
      ['/api/books/b1', () => dto({ audioPresent: false })],
    ])
    p.subscribe(() => {
      const s = p.getState()
      if (s.type === 'synthesizing') seen.push({ done: s.done, total: s.total })
    })
    p.startJob(specBook())
    await until(() => p.getState().type === 'done')
    // Every running poll's done/total flowed through (1/4 then 2/4); the
    // succeeded poll settles 'done' directly.
    expect(seen).toEqual(expect.arrayContaining([{ done: 1, total: 4 }]))
    expect(seen.at(-1)).toEqual({ done: 2, total: 4 })
  })

  it('audioPresent book (or resynth mode) triggers the resynth endpoint', async () => {
    let polls = 0
    let resynthBody: unknown
    const p = pipeline([
      [
        '/api/books/b1/resynth',
        (init) => {
          resynthBody = JSON.parse(String(init?.body))
          return { jobId: 'j1' }
        },
      ],
      [
        /\/api\/jobs\/j1$/,
        () => {
          polls += 1
          return jobDto({ status: 'succeeded', kind: 'resynth' })
        },
      ],
      ['/api/books/b1', () => dto({ audioPresent: true, voiceId: 'en_US-amy' })],
    ])

    // Explicit resynth mode (library card "synthesize again")…
    p.startJob(specBook({ mode: 'resynth' }))
    await until(() => p.getState().type === 'done')
    expect(resynthBody).toEqual({ voice: 'en_US-lessac' })
    expect(p.getState()).toMatchObject({ type: 'done', mode: 'resynth' })

    // …and an initial-mode job on a book that already has audio (race guard).
    p.dismiss()
    polls = 0
    p.startJob(specBook())
    await until(() => p.getState().type === 'done')
    expect(polls).toBe(1)
  })

  it('409 already-running adopts the in-flight job instead of erroring', async () => {
    const p = pipeline([
      ['/api/books/b1/synth', () => json(409, 'a synth job is already running for book b1')],
      ['/api/jobs', () => [jobDto({ status: 'running', done: 1, total: 9 })]],
      [/\/api\/jobs\/j1$/, () => jobDto({ status: 'succeeded' })],
      ['/api/books/b1', () => dto({ audioPresent: false })],
    ])

    p.startJob(specBook())
    await until(() => p.getState().type === 'done')
    expect(p.getState()).toMatchObject({ type: 'done', mode: 'initial' })
  })

  it('409 with nothing adoptable surfaces the server message as a retryable error', async () => {
    const p = pipeline([
      ['/api/books/b1/synth', () => json(409, 'book already has audio; use resynth')],
      ['/api/jobs', () => []],
      ['/api/books/b1', () => dto({ audioPresent: false })],
    ])

    p.startJob(specBook())
    await until(() => p.getState().type === 'error')
    const s = p.getState()
    expect(s).toMatchObject({ type: 'error', mode: 'initial' })
    if (s.type === 'error') {
      expect(s.message).toContain('resynth')
      expect(s.retryable).toBe(true)
    }
    expect(p.canRetry()).toBe(true)
  })

  it('job failure surfaces the server error message', async () => {
    const p = pipeline([
      ['/api/books/b1/synth', () => ({ jobId: 'j1' })],
      ['/api/books/b1', () => dto({ audioPresent: false })],
      [
        /\/api\/jobs\/j1$/,
        () => jobDto({ status: 'failed', error: 'voice model download failed' }),
      ],
    ])

    p.startJob(specBook())
    await until(() => p.getState().type === 'error')
    expect(p.getState()).toMatchObject({
      type: 'error',
      message: 'voice model download failed',
      mode: 'initial',
    })
  })

  it('retry re-runs the failed trigger', async () => {
    let attempt = 0
    const p = pipeline([
      [
        '/api/books/b1/synth',
        () => {
          attempt += 1
          return attempt === 1 ? json(500, 'boom') : { jobId: 'j1' }
        },
      ],
      [/\/api\/jobs\/j1$/, () => jobDto({ status: 'succeeded' })],
      ['/api/books/b1', () => dto({ audioPresent: false })],
    ])

    p.startJob(specBook())
    await until(() => p.getState().type === 'error')
    p.retry()
    await until(() => p.getState().type === 'done')
    expect(attempt).toBe(2)
  })

  it('unknown book on the server (probe 404) surfaces an error', async () => {
    const p = pipeline([['/api/books/b1', () => json(404, 'book not found')]])
    p.startJob(specBook())
    await until(() => p.getState().type === 'error')
    expect(p.getState()).toMatchObject({ type: 'error' })
  })

  it('poll 401 surfaces an error (cookie expired mid-job)', async () => {
    const p = pipeline([
      ['/api/books/b1/synth', () => ({ jobId: 'j1' })],
      ['/api/books/b1', () => dto({ audioPresent: false })],
      [/\/api\/jobs\/j1$/, () => json(401, 'unauthorized')],
    ])
    p.startJob(specBook())
    await until(() => p.getState().type === 'error')
    const s = p.getState()
    if (s.type === 'error') {
      expect(s.book.title).toBe('Wizards Abroad')
    }
  })

  it('startJob while active throws (re-entry guard)', () => {
    const p = pipeline([
      ['/api/books/b1/synth', () => ({ jobId: 'j1' })],
      ['/api/books/b1', () => dto({ audioPresent: false })],
      [/\/api\/jobs\/j1$/, () => jobDto({ status: 'running' })],
    ])
    p.startJob(specBook())
    expect(() => p.startJob(specBook())).toThrow('already running')
  })
})

describe('ServerSynthPipeline cancel (stop polling — the job keeps running server-side)', () => {
  it('flips cancelling → idle and stops the poll loop', async () => {
    let polls = 0
    const p = pipeline([
      ['/api/books/b1/synth', () => ({ jobId: 'j1' })],
      ['/api/books/b1', () => dto({ audioPresent: false })],
      [
        /\/api\/jobs\/j1$/,
        () => {
          polls += 1
          return jobDto({ status: 'running', done: polls, total: 100 })
        },
      ],
    ])

    p.startJob(specBook())
    await until(() => polls >= 2)
    p.cancel()
    await until(() => p.getState().type === 'idle')
    expect(p.getState()).toEqual({ type: 'idle' })

    const pollsAtCancel = polls
    await new Promise((r) => setTimeout(r, 30))
    expect(polls).toBe(pollsAtCancel)
  })
})

describe('ServerSynthPipeline passive surface', () => {
  it('passive queries keep mount-path subscribers inert', () => {
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

  it('delete guards answer no-op; the server 409 is authoritative', async () => {
    const p = createServerSynthPipeline()
    expect(await p.cancelForBook(bookId('b1'))).toEqual({ type: 'no-op' })
    expect(await p.cancelTransformForBook(bookId('b1'))).toEqual({ type: 'no-op' })
  })

  it('unsupported hosted operations still throw HostedModeUnavailableError', async () => {
    const p = createServerSynthPipeline()
    expect(() => p.pause()).toThrow(HostedModeUnavailableError)
    expect(() => p.pauseTransform()).toThrow(HostedModeUnavailableError)
    await expect(p.resumeTransform(bookId('b1'))).rejects.toBeInstanceOf(HostedModeUnavailableError)
    await expect(p.reparseChapters(bookId('b1'))).rejects.toBeInstanceOf(HostedModeUnavailableError)
    // startTransform surfaces pre-loop failures via the transform error
    // variant (local-manager contract), never throws.
    await p.startTransform(
      { book: specBook().book, ops: [] } as unknown as Parameters<typeof p.startTransform>[0],
      {
        ai: {} as Parameters<typeof p.startTransform>[1]['ai'],
        defs: [],
        synthEnabled: true,
      },
    )
    expect(p.getTransformState()).toMatchObject({ type: 'error' })
  })
})

// ---------------------------------------------------------------------------
// ServerSynthPipeline (T14) — reload recovery (R5)
// ---------------------------------------------------------------------------

describe('ServerSynthPipeline reload recovery (R5)', () => {
  it('recoverInFlightJobs adopts the newest non-terminal job and polls it', async () => {
    const p = pipeline([
      [
        '/api/jobs',
        () => [
          jobDto({ status: 'succeeded', id: 'j0' }),
          jobDto({ id: 'j1', status: 'running', done: 2, total: 7 }),
        ],
      ],
      ['/api/jobs/j1', () => jobDto({ status: 'succeeded', done: 7, total: 7 })],
      ['/api/books/b1', () => dto()],
    ])

    await p.recoverInFlightJobs()
    expect(p.getState()).toMatchObject({ type: 'synthesizing', done: 2, total: 7 })
    await until(() => p.getState().type === 'done')
    expect(p.getState()).toMatchObject({ type: 'done', mode: 'initial' })
  })

  it('recoverInFlightJobs stays idle when every recent job is terminal', async () => {
    let listFetches = 0
    const p = pipeline([
      [
        '/api/jobs',
        () => {
          listFetches += 1
          return [jobDto({ status: 'succeeded' }), jobDto({ status: 'failed' })]
        },
      ],
    ])
    await p.recoverInFlightJobs()
    expect(p.getState()).toEqual({ type: 'idle' })
    expect(listFetches).toBe(1)
  })

  it('recoverInFlightJobs is silent when the jobs list is unreachable', async () => {
    const p = pipeline([['/api/jobs', () => json(500, 'boom')]])
    await expect(p.recoverInFlightJobs()).resolves.toBeUndefined()
    expect(p.getState()).toEqual({ type: 'idle' })
  })

  it('resume adopts an in-flight job for the book; no in-flight job → no-op', async () => {
    const p = pipeline([
      [
        '/api/jobs',
        () => [jobDto({ id: 'j1', status: 'running', done: 1, total: 3, kind: 'resynth' })],
      ],
      ['/api/jobs/j1', () => jobDto({ status: 'succeeded', kind: 'resynth' })],
      ['/api/books/b1', () => dto({ audioPresent: true })],
    ])
    await p.resume(bookId('b1'))
    await until(() => p.getState().type === 'done')
    expect(p.getState()).toMatchObject({ type: 'done', mode: 'resynth' })

    const idle = pipeline([['/api/jobs', () => []]])
    await idle.resume(bookId('b1'))
    expect(idle.getState()).toEqual({ type: 'idle' })
  })
})

// ---------------------------------------------------------------------------
// ServerSynthPipeline (T14) — hosted transform (client-side loop → re-POST → synth)
// ---------------------------------------------------------------------------

const TRANSFORM_DEF = {
  id: 'upper',
  label: 'Uppercase',
  hint: '',
  desc: '',
  systemPrompt: '',
  params: [],
} as unknown as TransformDefinition

const transformDeps = (synthEnabled: boolean) => ({
  ai: { enabled: true } as unknown as AiSettings,
  defs: [TRANSFORM_DEF],
  synthEnabled,
})

function transformChapters(): Chapter[] {
  return [
    {
      id: chapterId('ch_b1_0'),
      bookId: bookId('b1'),
      index: 0,
      title: 'Chapter One',
      paragraphs: ['hello world.', 'second ¶.'],
    },
  ]
}

/** Capture re-POSTed bundles (parse the multipart field back into a bundle). */
function bundleCapture(): {
  bundles: Promise<BookBundleRouted>[]
  respond: (init?: RequestInit) => Promise<BookDto[]>
} {
  const bundles: Promise<BookBundleRouted>[] = []
  return {
    bundles,
    respond: (init) => {
      const entry = (init?.body as FormData | undefined)?.get('bundle') as File | null
      const parsed = entry
        ? entry.arrayBuffer().then((buf) => readBookBundle(new Uint8Array(buf)))
        : Promise.reject(new Error('no bundle field'))
      bundles.push(parsed as Promise<BookBundleRouted>)
      return Promise.resolve([dto()])
    },
  }
}

type BookBundleRouted = Awaited<ReturnType<typeof readBookBundle>>

describe('ServerSynthPipeline startTransform (client-side AI loop → re-POST → trigger)', () => {
  it('fresh book: transforms client-side, re-POSTs the transformed text, chains initial synth', async () => {
    engineMock.mockImplementation(async (paragraphs: string[]) =>
      paragraphs.map((p) => p.toUpperCase()),
    )
    const capture = bundleCapture()
    let synthBody: unknown
    const progressBodies: unknown[] = []
    const p = pipeline([
      ['/api/books', capture.respond],
      [
        '/api/books/b1/synth',
        (init) => {
          synthBody = JSON.parse(String(init?.body))
          return { jobId: 'j1' }
        },
      ],
      ['/api/jobs/j1', () => jobDto({ status: 'succeeded', done: 2, total: 2 })],
      [
        '/api/books/b1/progress',
        (init) => {
          progressBodies.push(JSON.parse(String(init?.body)))
          return dto()
        },
      ],
      ['/api/books/b1', () => dto({ audioPresent: false })],
    ])

    await p.startTransform(
      {
        book: specBook().book,
        chapters: transformChapters(),
        ops: [{ defId: 'upper', params: {} } as TransformOp],
        voiceId: 'en_US-lessac' as VoiceId,
        cleaning: idleCleaning,
      },
      transformDeps(true),
    )

    expect(p.getTransformState()).toMatchObject({ type: 'done', bookId: bookId('b1') })
    await until(() => p.getState().type === 'done')

    // The re-POSTed bundle carries the transformed paragraphs, the intended
    // voice, and the applied-processing record.
    expect(capture.bundles).toHaveLength(1)
    const bundle = await capture.bundles[0]
    if (!bundle) throw new Error('no bundle posted')
    expect(bundle.chapters[0]?.paragraphs).toEqual(['HELLO WORLD.', 'SECOND ¶.'])
    expect(bundle.manifest.book.voiceId).toBe('en_US-lessac')
    expect(bundle.manifest.audio.present).toBe(false)
    expect(bundle.meta.processing?.ops).toHaveLength(1)

    // Initial synth under the spec voice; position reset to the chapter start.
    expect(synthBody).toEqual({ voice: 'en_US-lessac' })
    expect(progressBodies).toEqual([{ chapterIndex: 0, paragraphIndex: 0, progressFraction: 0 }])
  })

  it("re-transform after synth: resynths under the book's current voice", async () => {
    engineMock.mockImplementation(async (paragraphs: string[]) => paragraphs)
    const capture = bundleCapture()
    let resynthBody: unknown
    const p = pipeline([
      ['/api/books', capture.respond],
      [
        '/api/books/b1/resynth',
        (init) => {
          resynthBody = JSON.parse(String(init?.body))
          return { jobId: 'j1' }
        },
      ],
      ['/api/jobs/j1', () => jobDto({ status: 'succeeded', kind: 'resynth' })],
      ['/api/books/b1/progress', () => dto()],
      ['/api/books/b1', () => dto({ audioPresent: true, voiceId: 'en_US-amy' })],
    ])

    await p.startTransform(
      {
        book: specBook().book,
        chapters: transformChapters(),
        ops: [{ defId: 'upper', params: {} } as TransformOp],
        voiceId: 'en_US-lessac' as VoiceId,
        cleaning: idleCleaning,
      },
      transformDeps(true),
    )
    await until(() => p.getState().type === 'done')

    const bundle = await capture.bundles[0]
    if (!bundle) throw new Error('no bundle posted')
    expect(bundle.manifest.book.voiceId).toBe('en_US-amy')
    expect(resynthBody).toEqual({ voice: 'en_US-amy' })
    expect(p.getState()).toMatchObject({ type: 'done', mode: 'resynth' })
  })

  it('engine failure surfaces a transform error and nothing is POSTed', async () => {
    engineMock.mockRejectedValue(new Error('provider quota exceeded'))
    const capture = bundleCapture()
    const p = pipeline([
      ['/api/books', capture.respond],
      ['/api/books/b1', () => dto()],
    ])

    await p.startTransform(
      {
        book: specBook().book,
        chapters: transformChapters(),
        ops: [{ defId: 'upper', params: {} } as TransformOp],
        voiceId: 'en_US-lessac' as VoiceId,
        cleaning: idleCleaning,
      },
      transformDeps(true),
    )

    expect(p.getTransformState()).toMatchObject({
      type: 'error',
      message: 'provider quota exceeded',
    })
    expect(capture.bundles).toHaveLength(0)
  })

  it('re-POST failure (413) surfaces a transform error', async () => {
    engineMock.mockImplementation(async (paragraphs: string[]) => paragraphs)
    const p = pipeline([
      ['/api/books', () => new Response('payload too large', { status: 413 })],
      ['/api/books/b1', () => dto()],
    ])

    await p.startTransform(
      {
        book: specBook().book,
        chapters: transformChapters(),
        ops: [{ defId: 'upper', params: {} } as TransformOp],
        voiceId: 'en_US-lessac' as VoiceId,
        cleaning: idleCleaning,
      },
      transformDeps(true),
    )

    expect(p.getTransformState()).toMatchObject({ type: 'error' })
    const s = p.getTransformState()
    if (s.type === 'error') {
      expect(s.message).toContain('uploading the transformed text failed')
    }
    expect(p.getState()).toEqual({ type: 'idle' })
  })

  it('cancelTransform aborts the loop, drops the in-memory output, never POSTs', async () => {
    engineMock.mockImplementation(
      (
        paragraphs: string[],
        _op: unknown,
        _def: unknown,
        _onProgress: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          if (signal?.aborted) return onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
          setTimeout(() => resolve(paragraphs.map((p) => p.toUpperCase())), 10_000)
        }),
    )
    const capture = bundleCapture()
    const p = pipeline([
      ['/api/books', capture.respond],
      ['/api/books/b1', () => dto()],
    ])

    const running = p.startTransform(
      {
        book: specBook().book,
        chapters: transformChapters(),
        ops: [{ defId: 'upper', params: {} } as TransformOp],
        voiceId: 'en_US-lessac' as VoiceId,
        cleaning: idleCleaning,
      },
      transformDeps(true),
    )
    await until(() => p.getTransformState().type === 'running')
    await p.cancelTransform()
    await running
    expect(p.getTransformState()).toEqual({ type: 'idle' })
    expect(capture.bundles).toHaveLength(0)
  })

  it('cancelTransformForBook: own running book cancels; another book blocks with its title', async () => {
    engineMock.mockImplementation(
      (
        _paragraphs: string[],
        _op: unknown,
        _def: unknown,
        _onProgress: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          if (signal?.aborted) return onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
          setTimeout(() => resolve([]), 10_000)
        }),
    )
    const p = pipeline([
      ['/api/books', bundleCapture().respond],
      ['/api/books/b1', () => dto()],
    ])

    const running = p.startTransform(
      {
        book: specBook().book,
        chapters: transformChapters(),
        ops: [{ defId: 'upper', params: {} } as TransformOp],
        voiceId: 'en_US-lessac' as VoiceId,
        cleaning: idleCleaning,
      },
      transformDeps(true),
    )
    await until(() => p.getTransformState().type === 'running')

    expect(await p.cancelTransformForBook(bookId('other'))).toEqual({
      type: 'blocked',
      activeBookTitle: 'Wizards Abroad',
    })
    expect(await p.cancelTransformForBook(bookId('b1'))).toEqual({ type: 'cancelled' })
    await running
    expect(p.getTransformState()).toEqual({ type: 'idle' })
  })
})

/** Local type alias for parameter-position typing in tests. */
type LibraryDs = ReturnType<typeof createServerDatasource>
