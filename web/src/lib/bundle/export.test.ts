import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioCacheRecord } from '../../types'

// fake-indexeddb (jsdom) structured-clones Blobs into empty plain objects —
// bytes + methods are lost. Real IndexedDB preserves Blobs intact. We shadow
// the audio cache in-memory so getAudioCacheEntry returns records with working
// Blobs, while getAudioCacheKeysByBook stays real (it reads string keys via the
// IDB index, which survive structured clone). Mirrors backup.test.ts, which
// tests blob byte logic out-of-band from IDB for the same reason.
const { audioShadow } = vi.hoisted(() => ({ audioShadow: new Map<string, AudioCacheRecord>() }))

vi.mock('../db', async (importActual) => {
  const actual = await importActual<typeof import('../db')>()
  return {
    ...actual,
    getAudioCacheEntry: async (key: string) => audioShadow.get(key),
    putAudioCacheEntry: async (rec: AudioCacheRecord) => {
      audioShadow.set(rec.key, rec)
      return actual.putAudioCacheEntry(rec)
    },
  }
})

import {
  type Book,
  type Chapter,
  newBookId,
  newChapterId,
  type VoiceId,
  voiceId,
} from '../../types'
import { audioCacheKey } from '../audio-cache'
import type { CleaningConfig } from '../clean/types'
import {
  _clearDBForTests,
  _resetDBForTests,
  putAudioCacheEntry,
  putBook,
  putBookFile,
  putChapters,
  setSetting,
} from '../db'
import { NORM_VERSION } from '../tts/normalize'
import { DEFAULT_VOICE_ID } from '../tts/voices'
import { NoAudioToExportError } from './errors'
import { exportBookBundle } from './export'
import { importBookBundle } from './import'
import type { BookBundle, Manifest } from './manifest'

const VOICE = voiceId('en_US-lessac-medium')
const ALT_VOICE = voiceId('en_US-hfc_female-medium')

const MIN_CLEANING: CleaningConfig = {
  enabled: true,
  filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
  pronunciation: [],
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  audioShadow.clear()
})

interface SeedOpts {
  title?: string
  format?: Book['format']
  chapters?: Array<{ title: string; paragraphs: string[] }>
  position?: Book['position']
  processing?: Book['processing']
  uploadJob?: Book['uploadJob']
  withFile?: { name: string }
}

async function seedBook(
  opts: SeedOpts = {},
): Promise<{ bookId: Book['id']; paragraphs: string[] }> {
  const bid = newBookId()
  const chapterDefs = opts.chapters ?? [
    { title: 'C1', paragraphs: ['Hello world.', 'Foo bar.'] },
    { title: 'C2', paragraphs: ['Hello world.', 'Baz qux.'] },
  ]
  const chapters: Chapter[] = chapterDefs.map((c, i) => ({
    id: newChapterId(),
    bookId: bid,
    index: i,
    title: c.title,
    paragraphs: c.paragraphs,
  }))
  const book: Book = {
    id: bid,
    title: opts.title ?? 'Export Test',
    format: opts.format ?? 'epub',
    chapterCount: chapters.length,
    createdAt: 1000,
    updatedAt: 2000,
    ...(opts.position !== undefined ? { position: opts.position } : {}),
    ...(opts.processing !== undefined ? { processing: opts.processing } : {}),
    ...(opts.uploadJob !== undefined ? { uploadJob: opts.uploadJob } : {}),
  }
  await putBook(book)
  await putChapters(chapters)
  if (opts.withFile !== undefined) {
    await putBookFile({
      bookId: bid,
      blob: new Blob([]),
      name: opts.withFile.name,
      type: 'application/epub+zip',
      size: 0,
    })
  }
  const paragraphs = [...new Set(chapterDefs.flatMap((c) => c.paragraphs))]
  return { bookId: bid, paragraphs }
}

async function cacheAudio(
  bookId: Book['id'],
  voice: VoiceId,
  texts: string[],
  bytes: number[] = [1, 2, 3, 4],
): Promise<void> {
  const now = Date.now()
  for (const text of texts) {
    const key = await audioCacheKey(voice, text)
    await putAudioCacheEntry({
      key,
      blob: new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }),
      bookId,
      sizeBytes: bytes.length,
      synthMs: 10,
      durationSeconds: 0.5,
      voiceId: voice,
      lastUsed: now,
      createdAt: now,
    })
  }
}

describe('exportBookBundle — full export', () => {
  it('recovers the voice from cached audio + exports one segment per distinct paragraph', async () => {
    const { bookId, paragraphs } = await seedBook()
    await cacheAudio(bookId, VOICE, paragraphs)

    const bundle = await exportBookBundle(bookId, { full: true })

    expect(bundle.audio.size).toBe(3)
    expect(bundle.manifest.book.voiceId).toBe(VOICE)
    expect(bundle.manifest.audio.present).toBe(true)
    expect(bundle.manifest.audio.segmentCount).toBe(3)
    expect(bundle.manifest.audio.codec).toBe('opus')
  })

  it('preserves cached audio bytes through the blob → Uint8Array conversion', async () => {
    const { bookId, paragraphs } = await seedBook()
    await cacheAudio(bookId, VOICE, paragraphs, [10, 20, 30])

    const bundle = await exportBookBundle(bookId, { full: true })

    expect(bundle.audio.size).toBeGreaterThan(0)
    for (const bytes of bundle.audio.values()) {
      expect(Array.from(bytes)).toEqual([10, 20, 30])
    }
  })

  it('throws NoAudioToExportError when the book owns no cached audio + has no uploadJob', async () => {
    const { bookId } = await seedBook()
    await expect(exportBookBundle(bookId, { full: true })).rejects.toBeInstanceOf(
      NoAudioToExportError,
    )
  })
})

describe('exportBookBundle — text-only export', () => {
  it('stamps the recovered voice when the book has cached audio (not the settings default)', async () => {
    const { bookId, paragraphs } = await seedBook()
    await cacheAudio(bookId, VOICE, paragraphs)
    await setSetting('app', { voiceId: ALT_VOICE })

    const bundle = await exportBookBundle(bookId, { full: false })

    expect(bundle.audio.size).toBe(0)
    expect(bundle.manifest.audio.present).toBe(false)
    expect(bundle.manifest.book.voiceId).toBe(VOICE)
  })

  it('falls back to the settings default voice when the book has no cached audio', async () => {
    const { bookId } = await seedBook()
    await setSetting('app', { voiceId: ALT_VOICE })

    const bundle = await exportBookBundle(bookId, { full: false })

    expect(bundle.manifest.book.voiceId).toBe(ALT_VOICE)
  })

  it('falls back to DEFAULT_VOICE_ID when neither cache nor settings expose a voice', async () => {
    const { bookId } = await seedBook()

    const bundle = await exportBookBundle(bookId, { full: false })

    expect(bundle.manifest.book.voiceId).toBe(DEFAULT_VOICE_ID)
  })

  it('recovers the voice from a paused uploadJob when no audio is cached', async () => {
    const bid = newBookId()
    const book: Book = {
      id: bid,
      title: 'Paused',
      format: 'txt',
      chapterCount: 1,
      createdAt: 1000,
      updatedAt: 2000,
      uploadJob: {
        voiceId: VOICE,
        cleaning: MIN_CLEANING,
        mode: 'initial',
        done: 0,
        total: 10,
        pausedAt: 5000,
      },
    }
    await putBook(book)
    await putChapters([
      { id: newChapterId(), bookId: bid, index: 0, title: 'C1', paragraphs: ['Hi.'] },
    ])

    const bundle = await exportBookBundle(bid, { full: false })

    expect(bundle.manifest.book.voiceId).toBe(VOICE)
  })
})

describe('exportBookBundle — chapters + meta round-trip', () => {
  it('maps chapters to the wire shape + carries position/processing/source meta', async () => {
    const { bookId } = await seedBook({
      position: { chapterIndex: 1, paragraphIndex: 2 },
      processing: { appliedAt: 9999, ops: [] },
      withFile: { name: 'origin.epub' },
    })

    const bundle = await exportBookBundle(bookId, { full: false })

    expect(bundle.chapters.map((c) => c.title)).toEqual(['C1', 'C2'])
    expect(bundle.chapters.map((c) => c.paragraphs)).toEqual([
      ['Hello world.', 'Foo bar.'],
      ['Hello world.', 'Baz qux.'],
    ])
    expect(bundle.meta.position).toEqual({ chapterIndex: 1, paragraphIndex: 2 })
    expect(bundle.meta.processing).toEqual({ appliedAt: 9999, ops: [] })
    expect(bundle.meta.source).toEqual({ filename: 'origin.epub', format: 'epub' })
  })

  it('omits position/processing/source when absent on the book', async () => {
    const { bookId } = await seedBook()
    const bundle = await exportBookBundle(bookId, { full: false })
    expect(bundle.meta.position).toBeUndefined()
    expect(bundle.meta.processing).toBeUndefined()
    expect(bundle.meta.source).toBeUndefined()
  })

  it('derives sourceFormat from Book.format (pdf)', async () => {
    const { bookId } = await seedBook({ format: 'pdf', withFile: { name: 'paper.pdf' } })
    const bundle = await exportBookBundle(bookId, { full: false })
    expect(bundle.meta.source?.format).toBe('pdf')
    expect(bundle.manifest.book.sourceFormat).toBe('pdf')
  })

  it('carries manifest.book progressFraction when present on the Book', async () => {
    const bid = newBookId()
    await putBook({
      id: bid,
      title: 'Progress',
      format: 'txt',
      chapterCount: 1,
      createdAt: 1,
      updatedAt: 2,
      progressFraction: 0.42,
    })
    await putChapters([
      { id: newChapterId(), bookId: bid, index: 0, title: 'C1', paragraphs: ['x.'] },
    ])

    const bundle = await exportBookBundle(bid, { full: false })

    expect(bundle.manifest.book.progressFraction).toBe(0.42)
  })
})

describe('exportBookBundle — IDB seam round-trip (import → export)', () => {
  it('re-exports an imported bundle with matching chapters, voice, + segment count', async () => {
    const keyA = await audioCacheKey(VOICE, 'Hello world.')
    const keyB = await audioCacheKey(VOICE, 'Foo bar.')
    const keyC = await audioCacheKey(VOICE, 'Baz qux.')
    const manifest: Manifest = {
      schemaVersion: 1,
      kind: 'book',
      book: {
        id: 'bk_orig',
        title: 'Round Trip',
        sourceFormat: 'txt',
        chapterCount: 2,
        voiceId: VOICE,
        createdAt: 1000,
        updatedAt: 2000,
      },
      audio: {
        present: true,
        codec: 'opus',
        normVersion: Number(NORM_VERSION),
        segmentCount: 3,
      },
      generator: { app: 'taletrek-desktop', version: '0.1.0' },
    }
    const bundle: BookBundle = {
      manifest,
      chapters: [
        {
          id: 'ch_1',
          bookId: 'bk_orig',
          index: 0,
          title: 'C1',
          paragraphs: ['Hello world.', 'Foo bar.'],
        },
        {
          id: 'ch_2',
          bookId: 'bk_orig',
          index: 1,
          title: 'C2',
          paragraphs: ['Hello world.', 'Baz qux.'],
        },
      ],
      audio: new Map([
        [keyA, new Uint8Array([1, 2])],
        [keyB, new Uint8Array([3, 4])],
        [keyC, new Uint8Array([5, 6])],
      ]),
      meta: {},
    }

    Object.defineProperty(navigator, 'storage', {
      value: { estimate: async () => ({ usage: 0, quota: Number.MAX_SAFE_INTEGER }) },
      configurable: true,
    })

    const result = await importBookBundle(bundle)
    const exported = await exportBookBundle(result.bookId, { full: true })

    expect(exported.manifest.book.voiceId).toBe(VOICE)
    expect(exported.audio.size).toBe(3)
    expect(exported.chapters.map((c) => c.paragraphs)).toEqual([
      ['Hello world.', 'Foo bar.'],
      ['Hello world.', 'Baz qux.'],
    ])
  })
})
