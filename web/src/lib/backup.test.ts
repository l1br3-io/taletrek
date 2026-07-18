import { beforeEach, describe, expect, it } from 'vitest'
import { type Book, type BookFile, type Chapter, newBookId, newChapterId } from '../types'
import {
  type BackupManifest,
  BackupTooLargeError,
  base64ToBlob,
  blobToBase64,
  CorruptBackupError,
  exportBackup,
  importBackup,
  isQuotaExceededError,
  parseManifest,
} from './backup'
import {
  _clearDBForTests,
  _resetDBForTests,
  getBook,
  getBookFile,
  getChaptersByBook,
  getSetting,
  putAudioCacheEntry,
  putBook,
  putChapters,
  setSetting,
} from './db'

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

function makeBook(overrides: Partial<Book> = {}): Book {
  const now = Date.now()
  return {
    id: newBookId(),
    title: 'Test Book',
    format: 'txt',
    chapterCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeChapters(bookId: Book['id'], count: number): Chapter[] {
  return Array.from({ length: count }, (_, index) => ({
    id: newChapterId(),
    bookId,
    index,
    title: `Chapter ${index}`,
    paragraphs: [`Para ${index}a`, `Para ${index}b`],
  }))
}

function makeBookFile(bookId: Book['id']): BookFile {
  const blob = new Blob(['ebook bytes'], { type: 'text/plain' })
  return { bookId, blob, name: 'book.txt', type: 'text/plain', size: blob.size }
}

/** Build a manifest in-memory (bypassing IDB's structured clone, which under
 * jsdom + fake-indexeddb drops Blob bytes — see the note at db.test.ts file
 * store tests which likewise only assert metadata, not blob bytes). This lets
 * us exercise importBackup with real base64 payload.
 */
async function buildManifest(
  books: Book[],
  chapters: Chapter[],
  files: BookFile[],
): Promise<BackupManifest> {
  return {
    app: 'taletrek',
    version: 1,
    dbVersion: 3,
    exportedAt: Date.now(),
    settings: [{ key: 'app', value: { theme: 'sepia', fontScale: 1.25 } }],
    books,
    chapters,
    files: await Promise.all(
      files.map(async (f) => ({
        bookId: f.bookId,
        name: f.name,
        type: f.type,
        size: f.size,
        blobBase64: await blobToBase64(f.blob),
      })),
    ),
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers — pure round-trip proves the byte layer (jsdom can't prove it
// across IDB structured clone; see note above).
// ---------------------------------------------------------------------------

describe('base64 helpers', () => {
  it('round-trips a small blob preserving bytes and type', async () => {
    const original = new Blob([new Uint8Array([1, 2, 3, 250, 0, 128])], { type: 'image/png' })
    const encoded = await blobToBase64(original)
    const decoded = base64ToBlob(encoded, 'image/png')
    expect(decoded.type).toBe('image/png')
    expect(decoded.size).toBe(original.size)
    const originalBytes = new Uint8Array(await original.arrayBuffer())
    const decodedBytes = new Uint8Array(await decoded.arrayBuffer())
    expect(Array.from(decodedBytes)).toEqual(Array.from(originalBytes))
  })

  it('handles an empty blob', async () => {
    const original = new Blob([], { type: 'application/octet-stream' })
    const decoded = base64ToBlob(await blobToBase64(original), 'application/octet-stream')
    expect(decoded.size).toBe(0)
  })

  it('encodes a large blob in chunks without stack overflow', async () => {
    const data = new Uint8Array(200 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const original = new Blob([data], { type: 'application/octet-stream' })
    const decoded = base64ToBlob(await blobToBase64(original), 'application/octet-stream')
    const decodedBytes = new Uint8Array(await decoded.arrayBuffer())
    expect(decodedBytes.length).toBe(data.length)
    expect(Array.from(decodedBytes)).toEqual(Array.from(data))
  })

  it('preserves binary ebook bytes through base64 round-trip', async () => {
    const binary = new Uint8Array(4096)
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 7) % 256
    const original = new Blob([binary], { type: 'application/pdf' })
    const decoded = base64ToBlob(await blobToBase64(original), 'application/pdf')
    const decodedBytes = new Uint8Array(await decoded.arrayBuffer())
    expect(Array.from(decodedBytes)).toEqual(Array.from(binary))
  })
})

// ---------------------------------------------------------------------------
// parseManifest validation
// ---------------------------------------------------------------------------

describe('parseManifest', () => {
  const validManifest: BackupManifest = {
    app: 'taletrek',
    version: 1,
    dbVersion: 3,
    exportedAt: 1000,
    settings: [],
    books: [],
    chapters: [],
    files: [],
  }

  it('parses a valid manifest', () => {
    expect(parseManifest(JSON.stringify(validManifest))).toEqual(validManifest)
  })

  it('throws on non-JSON', () => {
    expect(() => parseManifest('not json')).toThrow(CorruptBackupError)
  })

  it('throws on non-taletrek app', () => {
    expect(() => parseManifest(JSON.stringify({ app: 'other', version: 1 }))).toThrow(
      CorruptBackupError,
    )
  })

  it('throws on wrong version', () => {
    expect(() => parseManifest(JSON.stringify({ app: 'taletrek', version: 99 }))).toThrow(
      CorruptBackupError,
    )
  })

  it('throws on missing array fields', () => {
    const minimal = { app: 'taletrek', version: 1, dbVersion: 3, exportedAt: 1 }
    expect(() => parseManifest(JSON.stringify(minimal))).toThrow(CorruptBackupError)
  })
})

// ---------------------------------------------------------------------------
// isQuotaExceededError — pure predicate (the importBackup wrapper maps this
// to BackupTooLargeError; testing the predicate directly avoids fragile ESM
// module mocking under vitest's read-only export getters).
// ---------------------------------------------------------------------------

describe('isQuotaExceededError', () => {
  it('recognises the standard DOMException name', () => {
    expect(isQuotaExceededError(new DOMException('q', 'QuotaExceededError'))).toBe(true)
  })

  it('recognises the Firefox DOMException name', () => {
    expect(isQuotaExceededError(new DOMException('q', 'NS_ERROR_DOM_QUOTA_REACHED'))).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isQuotaExceededError(new Error('nope'))).toBe(false)
    expect(isQuotaExceededError(null)).toBe(false)
    expect(isQuotaExceededError(undefined)).toBe(false)
  })

  it('returns false for an unrelated DOMException', () => {
    expect(isQuotaExceededError(new DOMException('x', 'NotFoundError'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// exportBackup
// ---------------------------------------------------------------------------

describe('exportBackup', () => {
  it('produces a valid manifest of books, chapters, and settings', async () => {
    // Files are intentionally omitted: jsdom + fake-indexeddb drop Blob bytes
    // on structured clone (same convention as db.test.ts file-store tests), so
    // exportBackup's base64 path can't be exercised through IDB here. The base64
    // layer is covered by the pure helper tests above; the file-mapping shape is
    // covered by importBackup's metadata assertions below.
    const book1 = makeBook({ title: 'Book One' })
    const book2 = makeBook({ title: 'Book Two', format: 'epub' })
    const chapters = [...makeChapters(book1.id, 2), ...makeChapters(book2.id, 3)]
    await putBook(book1)
    await putBook(book2)
    await putChapters(chapters)
    await setSetting('app', { theme: 'sepia', fontScale: 1.25 })

    const manifest = parseManifest(await (await exportBackup()).text())

    expect(manifest.app).toBe('taletrek')
    expect(manifest.version).toBe(1)
    expect(manifest.dbVersion).toBe(3)
    expect(manifest.exportedAt).toBeGreaterThan(0)

    expect(manifest.books.map((b) => b.title).sort()).toEqual(['Book One', 'Book Two'])
    expect(manifest.chapters).toHaveLength(chapters.length)
    expect(manifest.settings.find((s) => s.key === 'app')?.value).toEqual({
      theme: 'sepia',
      fontScale: 1.25,
    })
  })

  it('produces an empty-but-valid manifest when the library is empty', async () => {
    const manifest = parseManifest(await (await exportBackup()).text())
    expect(manifest.books).toEqual([])
    expect(manifest.chapters).toEqual([])
    expect(manifest.files).toEqual([])
  })

  it('excludes the audioCache store entirely', async () => {
    await putAudioCacheEntry({
      key: 'voice:1:abc',
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/x-wav' }),
      bookId: newBookId(),
      sizeBytes: 4,
      synthMs: 10,
      durationSeconds: 1,
      voiceId: 'en_US-hfc_female-medium' as never,
      lastUsed: Date.now(),
      createdAt: Date.now(),
    })
    const text = await (await exportBackup()).text()
    expect(text).not.toContain('audioCache')
    expect(text).not.toContain('voice:1:abc')
  })
})

// ---------------------------------------------------------------------------
// importBackup — round-trip (books/chapters/settings verified through IDB;
// file bytes verified via the pure base64 helper tests above, since jsdom's
// structured clone drops Blob bytes — same convention as db.test.ts).
// ---------------------------------------------------------------------------

describe('importBackup round-trip', () => {
  it('restores books, chapters, and settings after the DB is wiped', async () => {
    const book1 = makeBook({ title: 'Book One' })
    const book2 = makeBook({ title: 'Book Two' })
    const chapters = [...makeChapters(book1.id, 2), ...makeChapters(book2.id, 3)]
    const manifest = await buildManifest([book1, book2], chapters, [
      makeBookFile(book1.id),
      makeBookFile(book2.id),
    ])
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' })

    _resetDBForTests()
    await _clearDBForTests()

    const report = await importBackup(blob)
    expect(report).toEqual({
      booksImported: 2,
      booksSkipped: 0,
      chaptersImported: chapters.length,
      filesImported: 2,
      settingsApplied: true,
    })

    for (const book of [book1, book2]) {
      expect(await getBook(book.id)).toEqual(book)
      const restoredChapters = await getChaptersByBook(book.id)
      expect(restoredChapters.map((c) => c.id).sort()).toEqual(
        chapters
          .filter((c) => c.bookId === book.id)
          .map((c) => c.id)
          .sort(),
      )
    }
    expect(await getSetting('app')).toEqual({ theme: 'sepia', fontScale: 1.25 })
  })

  it('restores file metadata for each imported book', async () => {
    const book = makeBook({ title: 'Solo' })
    const manifest = await buildManifest([book], [], [makeBookFile(book.id)])
    _resetDBForTests()
    await _clearDBForTests()

    await importBackup(new Blob([JSON.stringify(manifest)], { type: 'application/json' }))

    const file = await getBookFile(book.id)
    expect(file?.name).toBe('book.txt')
    expect(file?.type).toBe('text/plain')
    expect(file?.size).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// importBackup — conflict policy (skip existing)
// ---------------------------------------------------------------------------

describe('importBackup conflict handling', () => {
  it('skips books whose ID already exists locally, keeps local copy', async () => {
    const local = makeBook({ title: 'LOCAL OVERRIDE' })
    await putBook(local)

    const incoming = { ...local, title: 'INCOMING' }
    const manifest = await buildManifest([incoming], [], [])
    const report = await importBackup(
      new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    )

    expect(report.booksImported).toBe(0)
    expect(report.booksSkipped).toBe(1)
    expect(report.chaptersImported).toBe(0)
    expect(report.filesImported).toBe(0)

    expect((await getBook(local.id))?.title).toBe('LOCAL OVERRIDE')
  })

  it('skips chapters/files belonging to a skipped book', async () => {
    const book = makeBook()
    await putBook(book)
    await putChapters(makeChapters(book.id, 1))

    const manifest = await buildManifest([book], makeChapters(book.id, 3), [makeBookFile(book.id)])
    const report = await importBackup(
      new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    )

    expect(report.booksSkipped).toBe(1)
    expect(report.chaptersImported).toBe(0)
    expect(report.filesImported).toBe(0)
    // Local chapter untouched.
    expect(await getChaptersByBook(book.id)).toHaveLength(1)
  })

  it('imports new books alongside pre-existing ones (partial import)', async () => {
    const existing = makeBook({ title: 'Existing' })
    const fresh = makeBook({ title: 'Fresh' })
    await putBook(existing)

    const manifest = await buildManifest([existing, fresh], makeChapters(fresh.id, 2), [
      makeBookFile(fresh.id),
    ])
    const report = await importBackup(
      new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    )

    expect(report.booksImported).toBe(1)
    expect(report.booksSkipped).toBe(1)
    expect(await getBook(existing.id)).toBeDefined()
    expect(await getBook(fresh.id)).toBeDefined()
    expect(await getChaptersByBook(fresh.id)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// importBackup — settings option
// ---------------------------------------------------------------------------

describe('importBackup settings option', () => {
  const baseManifest = async (): Promise<BackupManifest> => ({
    app: 'taletrek',
    version: 1,
    dbVersion: 3,
    exportedAt: 1,
    settings: [{ key: 'app', value: { theme: 'sepia', fontScale: 1.25 } }],
    books: [],
    chapters: [],
    files: [],
  })

  it('overwrites local settings by default', async () => {
    await setSetting('app', { theme: 'dark', fontScale: 1 })
    await importBackup(
      new Blob([JSON.stringify(await baseManifest())], { type: 'application/json' }),
    )
    expect(await getSetting('app')).toEqual({ theme: 'sepia', fontScale: 1.25 })
  })

  it('leaves settings untouched when includeSettings is false', async () => {
    await setSetting('app', { theme: 'dark', fontScale: 1 })
    const report = await importBackup(
      new Blob([JSON.stringify(await baseManifest())], { type: 'application/json' }),
      { includeSettings: false },
    )
    expect(report.settingsApplied).toBe(false)
    expect(await getSetting('app')).toEqual({ theme: 'dark', fontScale: 1 })
  })
})

// ---------------------------------------------------------------------------
// importBackup — error paths
// ---------------------------------------------------------------------------

describe('importBackup error handling', () => {
  it('throws CorruptBackupError on invalid JSON', async () => {
    await expect(
      importBackup(new Blob(['not json'], { type: 'application/json' })),
    ).rejects.toThrow(CorruptBackupError)
  })

  it('throws CorruptBackupError on wrong app', async () => {
    await expect(
      importBackup(new Blob([JSON.stringify({ app: 'other' })], { type: 'application/json' })),
    ).rejects.toThrow(CorruptBackupError)
  })

  it('does not leave partial data on a corrupt-file failure', async () => {
    const junk = JSON.stringify({
      app: 'taletrek',
      version: 1,
      dbVersion: 3,
      exportedAt: 1,
      settings: 'not-an-array',
      books: [],
      chapters: [],
      files: [],
    })
    await expect(importBackup(new Blob([junk], { type: 'application/json' }))).rejects.toThrow(
      CorruptBackupError,
    )
    expect(await getSetting('app')).toBeUndefined()
  })

  it('BackupTooLargeError is constructible and named for easy catching', () => {
    const err = new BackupTooLargeError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('BackupTooLargeError')
    expect(err.message).toMatch(/quota/i)
  })
})
