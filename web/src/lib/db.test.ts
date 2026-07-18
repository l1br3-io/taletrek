import { beforeEach, describe, expect, it } from 'vitest'
import {
  type AudioCacheRecord,
  type Book,
  type BookFile,
  type Chapter,
  newBookId,
  newChapterId,
  voiceId,
} from '../types'
import { type AppliedProcessing, transformDefId } from './ai/types'
import {
  _clearDBForTests,
  _resetDBForTests,
  AUDIO_CACHE_BUDGET_BYTES,
  clearAudioCache,
  deleteAudioCacheKeys,
  deleteBookCascade,
  deleteSetting,
  evictAudioCacheFraction,
  evictAudioCacheToBudget,
  getAllBooks,
  getAudioCacheEntry,
  getAudioCacheKeysByBook,
  getAudioCacheSize,
  getBook,
  getBookFile,
  getChaptersByBook,
  getEffectiveAudioCacheBudget,
  getSetting,
  putAudioCacheEntry,
  putBook,
  putBookFile,
  putChapters,
  setPinnedAudioCacheBookId,
  setSetting,
  syncAudioCacheBudget,
  updateBookProcessing,
  updateBookProgress,
} from './db'

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('settings store', () => {
  it('round-trips a value through IndexedDB', async () => {
    await setSetting('theme', 'dark')
    expect(await getSetting('theme')).toBe('dark')
  })

  it('returns undefined for a missing key', async () => {
    expect(await getSetting('nope')).toBeUndefined()
  })

  it('overwrites an existing value', async () => {
    await setSetting('voice', 'piper-en')
    await setSetting('voice', 'piper-fr')
    expect(await getSetting('voice')).toBe('piper-fr')
  })

  it('deletes a value', async () => {
    await setSetting('speed', 1.25)
    await deleteSetting('speed')
    expect(await getSetting('speed')).toBeUndefined()
  })

  it('survives a connection reopen (durable across sessions)', async () => {
    await setSetting('position', { chapter: 3, offset: 1024 })
    _resetDBForTests()
    expect(await getSetting('position')).toEqual({ chapter: 3, offset: 1024 })
  })
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

describe('books store', () => {
  it('round-trips a book through IndexedDB', async () => {
    const { putBook, getBook } = await import('./db')
    const book = makeBook({ title: 'Moby Dick' })
    await putBook(book)
    expect(await getBook(book.id)).toEqual(book)
  })

  it('returns undefined for a missing book', async () => {
    const { getBook } = await import('./db')
    expect(await getBook(newBookId())).toBeUndefined()
  })

  it('getMostRecentBook returns the book with the highest updatedAt', async () => {
    const { putBook, getMostRecentBook } = await import('./db')
    const oldest = makeBook({ updatedAt: 1000 })
    const newest = makeBook({ updatedAt: 3000 })
    const middle = makeBook({ updatedAt: 2000 })
    await putBook(oldest)
    await putBook(newest)
    await putBook(middle)
    expect(await getMostRecentBook()).toEqual(newest)
  })

  it('getMostRecentBook returns undefined when no books exist', async () => {
    const { getMostRecentBook } = await import('./db')
    expect(await getMostRecentBook()).toBeUndefined()
  })

  it('deletes a book', async () => {
    const { putBook, deleteBook, getBook } = await import('./db')
    const book = makeBook()
    await putBook(book)
    await deleteBook(book.id)
    expect(await getBook(book.id)).toBeUndefined()
  })
})

describe('chapters store', () => {
  it('returns chapters for a book ordered by index', async () => {
    const { putChapters, getChaptersByBook } = await import('./db')
    const bookId = newBookId()
    const chapters: Chapter[] = [
      { id: newChapterId(), bookId, index: 2, title: 'C2', paragraphs: ['two'] },
      { id: newChapterId(), bookId, index: 0, title: 'C0', paragraphs: ['zero'] },
      { id: newChapterId(), bookId, index: 1, title: 'C1', paragraphs: ['one'] },
    ]
    await putChapters(chapters)
    const result = await getChaptersByBook(bookId)
    expect(result.map((c) => c.index)).toEqual([0, 1, 2])
  })

  it('returns an empty array when a book has no chapters', async () => {
    const { getChaptersByBook } = await import('./db')
    expect(await getChaptersByBook(newBookId())).toEqual([])
  })

  it('deletes chapters for a book', async () => {
    const { putChapters, getChaptersByBook, deleteChaptersByBook } = await import('./db')
    const bookId = newBookId()
    await putChapters([{ id: newChapterId(), bookId, index: 0, title: 'C0', paragraphs: ['x'] }])
    await deleteChaptersByBook(bookId)
    expect(await getChaptersByBook(bookId)).toEqual([])
  })
})

describe('files store', () => {
  it('round-trips a raw file record through IndexedDB', async () => {
    const { putBookFile, getBookFile } = await import('./db')
    const bookId = newBookId()
    const file: BookFile = {
      bookId,
      blob: new Blob(['hello world'], { type: 'text/plain' }),
      name: 'book.txt',
      type: 'text/plain',
      size: 11,
    }
    await putBookFile(file)
    const result = await getBookFile(bookId)
    expect(result?.name).toBe('book.txt')
    expect(result?.type).toBe('text/plain')
    expect(result?.size).toBe(11)
  })

  it('returns undefined for a missing file', async () => {
    const { getBookFile } = await import('./db')
    expect(await getBookFile(newBookId())).toBeUndefined()
  })
})

describe('library + progress (M5)', () => {
  it('getAllBooks returns books newest-first by updatedAt', async () => {
    const oldest = makeBook({ updatedAt: 1000 })
    const middle = makeBook({ updatedAt: 2000 })
    const newest = makeBook({ updatedAt: 3000 })
    await putBook(oldest)
    await putBook(middle)
    await putBook(newest)
    expect(await getAllBooks()).toEqual([newest, middle, oldest])
  })

  it('getAllBooks returns an empty array when no books exist', async () => {
    expect(await getAllBooks()).toEqual([])
  })

  it('a book stored without the new fields loads with them undefined', async () => {
    const book = makeBook({ title: 'Legacy' })
    await putBook(book)
    const loaded = await getBook(book.id)
    expect(loaded?.position).toBeUndefined()
    expect(loaded?.progressFraction).toBeUndefined()
  })

  it('updateBookProgress round-trips position + fraction and bumps updatedAt', async () => {
    const before = makeBook({ updatedAt: 1000 })
    await putBook(before)
    await updateBookProgress(before.id, { chapterIndex: 2, paragraphIndex: 5 }, 0.42)
    const after = await getBook(before.id)
    expect(after?.position).toEqual({ chapterIndex: 2, paragraphIndex: 5 })
    expect(after?.progressFraction).toBeCloseTo(0.42)
    expect(after?.updatedAt).toBeGreaterThan(1000)
  })

  it('updateBookProgress preserves the other book fields', async () => {
    const book = makeBook({ title: 'Keep Me', format: 'epub', chapterCount: 9 })
    await putBook(book)
    await updateBookProgress(book.id, { chapterIndex: 1, paragraphIndex: 1 }, 0.1)
    const after = await getBook(book.id)
    expect(after?.title).toBe('Keep Me')
    expect(after?.format).toBe('epub')
    expect(after?.chapterCount).toBe(9)
    expect(after?.createdAt).toBe(book.createdAt)
  })

  it('updateBookProgress is a no-op for a missing book', async () => {
    await expect(
      updateBookProgress(newBookId(), { chapterIndex: 0, paragraphIndex: 0 }, 0),
    ).resolves.toBeUndefined()
  })

  it('updateBookProcessing round-trips a processing record and bumps updatedAt', async () => {
    const book = makeBook({ updatedAt: 1000 })
    await putBook(book)
    const processing: AppliedProcessing = {
      appliedAt: 1234,
      ops: [
        { defId: transformDefId('cleanup'), params: {} },
        { defId: transformDefId('translate'), params: { target: 'es' } },
      ],
    }
    await updateBookProcessing(book.id, processing)
    const after = await getBook(book.id)
    expect(after?.processing).toEqual(processing)
    expect(after?.updatedAt).toBeGreaterThan(1000)
  })

  it('updateBookProcessing(undefined) clears the record', async () => {
    const book = makeBook()
    await putBook(book)
    await updateBookProcessing(book.id, {
      appliedAt: 1,
      ops: [{ defId: transformDefId('cleanup'), params: {} }],
    })
    expect((await getBook(book.id))?.processing).toBeDefined()
    await updateBookProcessing(book.id, undefined)
    expect((await getBook(book.id))?.processing).toBeUndefined()
  })

  it('updateBookProcessing is a no-op for a missing book', async () => {
    await expect(updateBookProcessing(newBookId(), undefined)).resolves.toBeUndefined()
  })

  it('deleteBookCascade removes the book, its chapters, its file, and its audio cache (M8)', async () => {
    const target = makeBook()
    const other = makeBook()
    await putBook(target)
    await putBook(other)
    await putChapters([
      { id: newChapterId(), bookId: target.id, index: 0, title: 'T0', paragraphs: ['x'] },
      { id: newChapterId(), bookId: target.id, index: 1, title: 'T1', paragraphs: ['y'] },
      { id: newChapterId(), bookId: other.id, index: 0, title: 'O0', paragraphs: ['z'] },
    ])
    await putBookFile({
      bookId: target.id,
      blob: new Blob(['x'], { type: 'text/plain' }),
      name: 't.txt',
      type: 'text/plain',
      size: 1,
    })
    const targetAudio = makeAudioCacheRecord({ bookId: target.id, key: 'target-1' })
    const otherAudio = makeAudioCacheRecord({ bookId: other.id, key: 'other-1' })
    await putAudioCacheEntry(targetAudio)
    await putAudioCacheEntry(otherAudio)

    await deleteBookCascade(target.id)

    expect(await getBook(target.id)).toBeUndefined()
    expect(await getChaptersByBook(target.id)).toEqual([])
    expect(await getBookFile(target.id)).toBeUndefined()
    // target's audio entries gone; sibling's untouched (atomic cascade)
    expect(await getAudioCacheEntry('target-1')).toBeUndefined()
    expect(await getAudioCacheKeysByBook(target.id)).toEqual([])
    expect(await getAudioCacheEntry('other-1')).toBeDefined()
    expect(await getAudioCacheKeysByBook(other.id)).toEqual(['other-1'])
    // sibling book untouched
    expect(await getBook(other.id)).toEqual(other)
    expect((await getChaptersByBook(other.id)).map((c) => c.title)).toEqual(['O0'])
  })
})

function makeAudioCacheRecord(overrides: Partial<AudioCacheRecord> = {}): AudioCacheRecord {
  const blob = overrides.blob ?? new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/x-wav' })
  return {
    key: 'k1',
    blob,
    bookId: newBookId(),
    sizeBytes: overrides.sizeBytes ?? blob.size,
    synthMs: 12,
    durationSeconds: 1,
    voiceId: voiceId('en_US-hfc_female-medium'),
    lastUsed: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('audio cache store (M8)', () => {
  it('round-trips an entry and returns undefined on miss', async () => {
    const record = makeAudioCacheRecord({ key: 'round-trip' })
    await putAudioCacheEntry(record)
    const hit = await getAudioCacheEntry('round-trip')
    expect(hit?.key).toBe('round-trip')
    expect(hit?.blob).toBeDefined()
    expect(hit?.sizeBytes).toBe(record.sizeBytes)
    expect(hit?.voiceId).toEqual(record.voiceId)
    expect(await getAudioCacheEntry('missing')).toBeUndefined()
  })

  it('getAudioCacheEntry bumps lastUsed on hit', async () => {
    const old = Date.now() - 10_000
    const record = makeAudioCacheRecord({ key: 'lru', lastUsed: old })
    await putAudioCacheEntry(record)
    const before = Date.now()
    const hit = await getAudioCacheEntry('lru')
    expect(hit?.lastUsed).toBeGreaterThanOrEqual(before)
    expect(hit?.lastUsed).toBeGreaterThan(old)
  })

  it('getAudioCacheSize sums sizeBytes across entries', async () => {
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'a', sizeBytes: 100 }))
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'b', sizeBytes: 250 }))
    expect(await getAudioCacheSize()).toBe(350)
  })

  it('getAudioCacheKeysByBook returns only the requested book keys', async () => {
    const bookA = newBookId()
    const bookB = newBookId()
    await putAudioCacheEntry(makeAudioCacheRecord({ bookId: bookA, key: 'a-1' }))
    await putAudioCacheEntry(makeAudioCacheRecord({ bookId: bookA, key: 'a-2' }))
    await putAudioCacheEntry(makeAudioCacheRecord({ bookId: bookB, key: 'b-1' }))
    expect(await getAudioCacheKeysByBook(bookA).then((ks) => ks.sort())).toEqual(['a-1', 'a-2'])
  })

  it('evictAudioCacheToBudget removes oldest-first until under budget', async () => {
    // Insert 3 entries: oldest, middle, newest. Budget = 200 forces 2 evictions.
    await putAudioCacheEntry(
      makeAudioCacheRecord({ key: 'oldest', sizeBytes: 100, lastUsed: 1000 }),
    )
    await putAudioCacheEntry(
      makeAudioCacheRecord({ key: 'middle', sizeBytes: 100, lastUsed: 2000 }),
    )
    await putAudioCacheEntry(
      makeAudioCacheRecord({ key: 'newest', sizeBytes: 100, lastUsed: 3000 }),
    )
    const removed = await evictAudioCacheToBudget(200)
    expect(removed).toBe(1)
    expect(await getAudioCacheEntry('oldest')).toBeUndefined()
    expect(await getAudioCacheEntry('middle')).toBeDefined()
    expect(await getAudioCacheEntry('newest')).toBeDefined()
  })

  it('evictAudioCacheToBudget is a no-op when already under budget', async () => {
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'only', sizeBytes: 10 }))
    expect(await evictAudioCacheToBudget(1000)).toBe(0)
    expect(await getAudioCacheEntry('only')).toBeDefined()
  })

  it('evictAudioCacheFraction removes the oldest N*fraction entries', async () => {
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'a', lastUsed: 1 }))
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'b', lastUsed: 2 }))
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'c', lastUsed: 3 }))
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'd', lastUsed: 4 }))
    const removed = await evictAudioCacheFraction(0.5)
    expect(removed).toBe(2)
    expect(await getAudioCacheEntry('a')).toBeUndefined()
    expect(await getAudioCacheEntry('b')).toBeUndefined()
    expect(await getAudioCacheEntry('c')).toBeDefined()
    expect(await getAudioCacheEntry('d')).toBeDefined()
  })

  it('evictAudioCacheToBudget skips entries pinned to the active book', async () => {
    const pinnedBook = newBookId()
    const otherBook = newBookId()
    await putAudioCacheEntry(
      makeAudioCacheRecord({ bookId: otherBook, key: 'other', sizeBytes: 100, lastUsed: 1000 }),
    )
    await putAudioCacheEntry(
      makeAudioCacheRecord({ bookId: pinnedBook, key: 'pinned', sizeBytes: 100, lastUsed: 2000 }),
    )
    setPinnedAudioCacheBookId(pinnedBook)
    const removed = await evictAudioCacheToBudget(100)
    setPinnedAudioCacheBookId(null)
    expect(removed).toBe(1)
    expect(await getAudioCacheEntry('other')).toBeUndefined()
    expect(await getAudioCacheEntry('pinned')).toBeDefined()
  })

  it('evictAudioCacheFraction skips entries pinned to the active book', async () => {
    const pinnedBook = newBookId()
    const otherBook = newBookId()
    await putAudioCacheEntry(
      makeAudioCacheRecord({ bookId: otherBook, key: 'other', sizeBytes: 100, lastUsed: 1000 }),
    )
    await putAudioCacheEntry(
      makeAudioCacheRecord({ bookId: pinnedBook, key: 'pinned', sizeBytes: 100, lastUsed: 2000 }),
    )
    setPinnedAudioCacheBookId(pinnedBook)
    const removed = await evictAudioCacheFraction(0.5)
    setPinnedAudioCacheBookId(null)
    expect(removed).toBe(1)
    expect(await getAudioCacheEntry('other')).toBeUndefined()
    expect(await getAudioCacheEntry('pinned')).toBeDefined()
  })

  it('putAudioCacheEntry triggers an LRU sweep when over budget', async () => {
    // Drop the budget temporarily by evicting to a tiny number after seeding.
    // Easier: seed 4 small entries, set budget via direct evict, then add one
    // more that pushes over and verify oldest got pruned by the put path.
    for (let i = 0; i < 4; i++) {
      await putAudioCacheEntry(
        makeAudioCacheRecord({
          key: `e${i}`,
          sizeBytes: AUDIO_CACHE_BUDGET_BYTES / 2,
          lastUsed: 1000 + i,
        }),
      )
    }
    // Each entry is half the budget; 2 entries already exceed it. The put path
    // should have pruned back to one entry after each over-budget write.
    expect(await getAudioCacheSize()).toBeLessThanOrEqual(AUDIO_CACHE_BUDGET_BYTES)
  })

  it('clearAudioCache empties the store and returns the count', async () => {
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'a' }))
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'b' }))
    const removed = await clearAudioCache()
    expect(removed).toBe(2)
    expect(await getAudioCacheSize()).toBe(0)
  })
})

describe('audio cache — dynamic budget', () => {
  it('getEffectiveAudioCacheBudget returns the default when no key is set', async () => {
    expect(await getEffectiveAudioCacheBudget()).toBe(AUDIO_CACHE_BUDGET_BYTES)
  })

  it('syncAudioCacheBudget writes the value and getEffectiveAudioCacheBudget reads it', async () => {
    await syncAudioCacheBudget(123 * 1024 * 1024)
    expect(await getEffectiveAudioCacheBudget()).toBe(123 * 1024 * 1024)
  })

  it('putAudioCacheEntry respects a lowered dynamic budget', async () => {
    // Set a tiny budget so a single entry exceeds it.
    await syncAudioCacheBudget(50)
    // Insert two entries; the first should be evicted when the second is
    // written because the budget is 50 bytes.
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'first', sizeBytes: 30, lastUsed: 1000 }))
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'second', sizeBytes: 30, lastUsed: 2000 }))
    expect(await getAudioCacheEntry('first')).toBeUndefined()
    expect(await getAudioCacheEntry('second')).toBeDefined()
    // Restore default for subsequent tests.
    await syncAudioCacheBudget(AUDIO_CACHE_BUDGET_BYTES)
  })

  it('syncAudioCacheBudget(Infinity) disables the reactive sweep', async () => {
    await syncAudioCacheBudget(Number.POSITIVE_INFINITY)
    expect(await getEffectiveAudioCacheBudget()).toBe(Infinity)
    // Seed many large entries — none should be evicted by the put path.
    for (let i = 0; i < 5; i++) {
      await putAudioCacheEntry(
        makeAudioCacheRecord({ key: `big-${i}`, sizeBytes: 10 * 1024 * 1024, lastUsed: 1000 + i }),
      )
    }
    for (let i = 0; i < 5; i++) {
      expect(await getAudioCacheEntry(`big-${i}`)).toBeDefined()
    }
    // Restore default for subsequent tests.
    await syncAudioCacheBudget(AUDIO_CACHE_BUDGET_BYTES)
  })
})

describe('audio cache — per-key delete', () => {
  it('deleteAudioCacheKeys removes the specified entries and leaves others', async () => {
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'keep-1' }))
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'drop-1' }))
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'drop-2' }))
    const removed = await deleteAudioCacheKeys(['drop-1', 'drop-2'])
    expect(removed).toBe(2)
    expect(await getAudioCacheEntry('keep-1')).toBeDefined()
    expect(await getAudioCacheEntry('drop-1')).toBeUndefined()
    expect(await getAudioCacheEntry('drop-2')).toBeUndefined()
  })

  it('deleteAudioCacheKeys is a no-op for an empty list', async () => {
    await putAudioCacheEntry(makeAudioCacheRecord({ key: 'solo' }))
    expect(await deleteAudioCacheKeys([])).toBe(0)
    expect(await getAudioCacheEntry('solo')).toBeDefined()
  })
})
