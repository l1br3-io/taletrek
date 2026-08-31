import { beforeEach, describe, expect, it } from 'vitest'
import { type AudioCacheRecord, type BookFormat, newBookId, voiceId } from '../../types'
import {
  _clearDBForTests,
  _resetDBForTests,
  getAudioCacheEntry,
  getAudioCacheSize,
  getBook,
  getBookFile,
  getChaptersByBook,
  getDB,
  putAudioCacheEntry,
} from '../db'
import { BundleTooLargeError } from './errors'
import { importBookBundle } from './import'
import type { BookBundle, Manifest } from './manifest'

const VOICE = 'en_US-lessac-medium'
const KEY_A = `${VOICE}:2:${'a'.repeat(64)}`
const KEY_B = `${VOICE}:2:${'b'.repeat(64)}`

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  // jsdom ships no StorageManager — polyfill a permissive default so the
  // importer's pre-flight passes. The low-quota test overrides this.
  Object.defineProperty(navigator, 'storage', {
    value: { estimate: async () => ({ usage: 0, quota: Number.MAX_SAFE_INTEGER }) },
    configurable: true,
  })
})

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    kind: 'book',
    book: {
      id: 'bk_orig',
      title: 'Test Book',
      sourceFormat: 'txt',
      chapterCount: 2,
      voiceId: VOICE,
      createdAt: 1000,
      updatedAt: 2000,
    },
    audio: { present: false, codec: 'opus', normVersion: 2, segmentCount: 0 },
    generator: { app: 'taletrek-desktop', version: '0.1.0' },
    ...overrides,
  }
}

function bundleChapters(): BookBundle['chapters'] {
  return [
    { id: 'ch_1', bookId: 'bk_orig', index: 0, title: 'One', paragraphs: ['Hello.', 'World.'] },
    { id: 'ch_2', bookId: 'bk_orig', index: 1, title: 'Two', paragraphs: ['Foo.', 'Bar baz.'] },
  ]
}

function fullBundle(): BookBundle {
  return {
    manifest: manifest({
      audio: { present: true, codec: 'opus', normVersion: 2, segmentCount: 2 },
    }),
    chapters: bundleChapters(),
    audio: new Map([
      [KEY_A, new Uint8Array([1, 2, 3, 4])],
      [KEY_B, new Uint8Array([5, 6, 7, 8])],
    ]),
    meta: {},
  }
}

async function audioCacheCount(): Promise<number> {
  const db = await getDB()
  return db.count('audioCache')
}

describe('importBookBundle — happy path', () => {
  it('writes the book, chapters, and one audioCache entry per distinct paragraph', async () => {
    const result = await importBookBundle(fullBundle())

    expect(result.imported.chapters).toBe(2)
    expect(result.imported.audio).toBe(2)

    const book = await getBook(result.bookId)
    expect(book).toBeDefined()
    expect(book?.title).toBe('Test Book')
    expect(book?.format).toBe('txt')
    expect(book?.chapterCount).toBe(2)
    expect(book?.createdAt).toBe(1000)
    expect(book?.updatedAt).toBe(2000)

    const chapters = await getChaptersByBook(result.bookId)
    expect(chapters).toHaveLength(2)
    expect(chapters.map((c) => c.title)).toEqual(['One', 'Two'])
    expect(chapters.map((c) => c.paragraphs)).toEqual([
      ['Hello.', 'World.'],
      ['Foo.', 'Bar baz.'],
    ])

    expect(await audioCacheCount()).toBe(2)
    expect(await getAudioCacheSize()).toBe(8)
  })

  it('imports a text-only bundle (no audio entries written)', async () => {
    const bundle = fullBundle()
    bundle.audio = new Map()
    bundle.manifest.audio.present = false

    const result = await importBookBundle(bundle)

    expect(result.imported.audio).toBe(0)
    expect(await audioCacheCount()).toBe(0)
    const chapters = await getChaptersByBook(result.bookId)
    expect(chapters).toHaveLength(2)
  })
})

describe('importBookBundle — fresh-id-on-collision (never overwrites)', () => {
  it('re-importing the same bundle creates a second book with a distinct id + distinct chapter ids', async () => {
    const bundle = fullBundle()
    const first = await importBookBundle(bundle)
    const second = await importBookBundle(bundle)

    expect(first.bookId).not.toBe(second.bookId)

    const [book1, book2] = await Promise.all([getBook(first.bookId), getBook(second.bookId)])
    expect(book1).toBeDefined()
    expect(book2).toBeDefined()

    const [chs1, chs2] = await Promise.all([
      getChaptersByBook(first.bookId),
      getChaptersByBook(second.bookId),
    ])
    expect(chs1).toHaveLength(2)
    expect(chs2).toHaveLength(2)
    // Fresh chapter ids — the bundle's original ids are never reused.
    expect(chs1.map((c) => c.id)).not.toEqual(chs2.map((c) => c.id))
    // Neither set carries the bundle's original chapter ids.
    expect(chs1.concat(chs2).map((c) => c.id)).not.toContain('ch_1')
    expect(chs1.concat(chs2).map((c) => c.id)).not.toContain('ch_2')
  })

  it('does not carry the bundle manifest book id onto the imported Book record', async () => {
    const result = await importBookBundle(fullBundle())
    expect(result.bookId).not.toBe('bk_orig')
  })

  it('still produces a fresh id when the bundle id collides with a pre-existing local book', async () => {
    // Pre-seed the DB with a book whose id matches the bundle's manifest id.
    // The importer must ignore that and allocate its own id regardless.
    const result = await importBookBundle(fullBundle())
    const directIdAttempt = await getBook(newBookId())
    expect(directIdAttempt).toBeUndefined()
    expect(result.bookId).not.toBe('bk_orig')
  })
})

describe('importBookBundle — content-addressed audio dedup', () => {
  it('second import of the same full bundle writes zero new audioCache entries', async () => {
    const bundle = fullBundle()
    const first = await importBookBundle(bundle)
    expect(first.imported.audio).toBe(2)
    expect(await audioCacheCount()).toBe(2)

    const second = await importBookBundle(bundle)
    expect(second.imported.audio).toBe(0)
    expect(await audioCacheCount()).toBe(2)
    expect(await getAudioCacheSize()).toBe(8)
  })

  it('skips audio entries already cached (paragraphs synthed on-device stay put)', async () => {
    // Simulate an on-device-synthed paragraph already in the cache under the
    // same content-addressed key the bundle will reference.
    const existing: AudioCacheRecord = {
      key: KEY_A,
      blob: new Blob([new Uint8Array([9, 9, 9])], { type: 'audio/x-wav' }),
      sizeBytes: 3,
      synthMs: 100,
      durationSeconds: 1.5,
      voiceId: voiceId(VOICE),
      lastUsed: 1,
      createdAt: 1,
    }
    await putAudioCacheEntry(existing)

    const result = await importBookBundle(fullBundle())

    // Only KEY_B was new; KEY_A was already cached.
    expect(result.imported.audio).toBe(1)
    expect(await audioCacheCount()).toBe(2)

    const kept = await getAudioCacheEntry(KEY_A)
    expect(kept?.sizeBytes).toBe(3) // original entry untouched, not overwritten
  })
})

describe('importBookBundle — meta/* round-trip', () => {
  it('lands meta/position onto Book.position and meta/processing onto Book.processing', async () => {
    const bundle = fullBundle()
    bundle.meta = {
      position: { chapterIndex: 1, paragraphIndex: 3 },
      processing: { appliedAt: 9999, ops: [] },
    }

    const result = await importBookBundle(bundle)
    const book = await getBook(result.bookId)

    expect(book?.position).toEqual({ chapterIndex: 1, paragraphIndex: 3 })
    expect(book?.processing).toEqual({ appliedAt: 9999, ops: [] })
  })

  it('carries manifest.book.progressFraction onto Book.progressFraction when present', async () => {
    const bundle = fullBundle()
    bundle.manifest.book.progressFraction = 0.42

    const result = await importBookBundle(bundle)
    const book = await getBook(result.bookId)
    expect(book?.progressFraction).toBe(0.42)
  })

  it('restores meta/source as a BookFile provenance record (filename preserved, bytes empty)', async () => {
    const bundle = fullBundle()
    bundle.meta = { source: { filename: 'origin.epub', format: 'epub' } }

    const result = await importBookBundle(bundle)
    const file = await getBookFile(result.bookId)

    expect(file).toBeDefined()
    expect(file?.name).toBe('origin.epub')
  })

  it('omits position/processing/bookFile when meta/* is absent', async () => {
    const result = await importBookBundle(fullBundle())
    const book = await getBook(result.bookId)

    expect(book?.position).toBeUndefined()
    expect(book?.processing).toBeUndefined()
    expect(await getBookFile(result.bookId)).toBeUndefined()
  })
})

describe('importBookBundle — sourceFormat mapping', () => {
  it.each([
    ['pdf', 'pdf'],
    ['epub', 'epub'],
    ['mobi', 'mobi'],
    ['txt', 'txt'],
    ['md', 'md'],
    ['html', 'html'],
    ['docx', 'docx'],
  ] as const)('maps bundle sourceFormat "%s" to BookFormat "%s"', async (sf, expected) => {
    const bundle = fullBundle()
    bundle.manifest.book.sourceFormat = sf
    const result = await importBookBundle(bundle)
    const book = await getBook(result.bookId)
    expect(book?.format).toBe(expected as BookFormat)
  })

  it('maps bundle sourceFormat "unknown" to BookFormat "txt" (least-lossy default)', async () => {
    const bundle = fullBundle()
    bundle.manifest.book.sourceFormat = 'unknown'
    const result = await importBookBundle(bundle)
    const book = await getBook(result.bookId)
    expect(book?.format).toBe('txt')
  })
})

describe('importBookBundle — size guard', () => {
  it('throws BundleTooLargeError pre-flight when remaining quota is insufficient', async () => {
    // Bundle footprint = 8 audio bytes + ~30 chars of chapter text.
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: async () => ({ usage: 0, quota: 7 }) },
      configurable: true,
    })

    await expect(importBookBundle(fullBundle())).rejects.toBeInstanceOf(BundleTooLargeError)

    // Nothing was written — the guard fires before any IDB write.
    expect(await audioCacheCount()).toBe(0)
    const books = await getDB().then((db) => db.count('books'))
    expect(await books).toBe(0)
  })

  it('does not throw when storage.estimate is unavailable (best-effort skip)', async () => {
    // Drop the storage API entirely (old browser / restricted context).
    Object.defineProperty(navigator, 'storage', {
      value: undefined,
      configurable: true,
    })

    const result = await importBookBundle(fullBundle())
    expect(result.imported.audio).toBe(2)
  })
})
