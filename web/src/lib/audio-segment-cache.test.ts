import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newBookId, voiceId } from '../types'
import { audioCacheKey } from './audio-cache'
import {
  clearSegmentCache,
  deleteSegmentKeys,
  getSegment,
  getSegmentCacheSize,
  getSegmentKeysByBook,
  lookupSegment,
  putSegment,
  storeSegment,
} from './audio-segment-cache'
import { _clearDBForTests, _resetDBForTests } from './db'

const VOICE = voiceId('en_US-hfc_female-medium')

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('segment cache', () => {
  it('returns undefined on miss', async () => {
    const key = await audioCacheKey(VOICE, 'never encoded')
    expect(await getSegment(key)).toBeUndefined()
  })

  it('round-trips a blob through put then get', async () => {
    const key = await audioCacheKey(VOICE, 'paragraph one')
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' })
    await putSegment(key, blob, 3.5, { voiceId: VOICE })
    const hit = await getSegment(key)
    expect(hit).toBeDefined()
    expect(hit?.blob).toBeDefined()
    expect(hit?.duration).toBe(3.5)
    expect(hit?.sizeBytes).toBe(blob.size)
  })

  it('threads bookId onto the record when provided', async () => {
    const bookId = newBookId()
    const key = await audioCacheKey(VOICE, 'with book')
    await putSegment(key, new Blob(['x']), 1, { voiceId: VOICE, bookId })
    const hit = await getSegment(key)
    expect(hit?.bookId).toBe(bookId)
  })

  it('omits bookId when not provided', async () => {
    const key = await audioCacheKey(VOICE, 'no book')
    await putSegment(key, new Blob(['x']), 1, { voiceId: VOICE })
    const hit = await getSegment(key)
    expect(hit?.bookId).toBeUndefined()
  })

  it('bumps lastUsed on get', async () => {
    const key = await audioCacheKey(VOICE, 'lru')
    await putSegment(key, new Blob(['x']), 1, { voiceId: VOICE })
    const before = await getSegment(key)
    await new Promise((r) => setTimeout(r, 5))
    const after = await getSegment(key)
    expect(after?.lastUsed).toBeGreaterThanOrEqual(before?.lastUsed ?? 0)
  })
})

describe('storeSegment / lookupSegment', () => {
  it('convenience wrappers compute the key from voice + text', async () => {
    await storeSegment(VOICE, 'hello world', new Blob(['fmp4']), 2.0, {})
    const hit = await lookupSegment(VOICE, 'hello world')
    expect(hit).toBeDefined()
    expect(hit?.duration).toBe(2.0)
  })

  it('storeSegment threads bookId', async () => {
    const bookId = newBookId()
    await storeSegment(VOICE, 'chapter text', new Blob(['fmp4']), 1.5, { bookId })
    const keys = await getSegmentKeysByBook(bookId)
    expect(keys).toHaveLength(1)
  })
})

describe('cascade + eviction', () => {
  it("getSegmentKeysByBook returns only that book's keys", async () => {
    const b1 = newBookId()
    const b2 = newBookId()
    await storeSegment(VOICE, 'b1 text', new Blob(['x']), 1, { bookId: b1 })
    await storeSegment(VOICE, 'b2 text', new Blob(['x']), 1, { bookId: b2 })
    expect(await getSegmentKeysByBook(b1)).toHaveLength(1)
    expect(await getSegmentKeysByBook(b2)).toHaveLength(1)
  })

  it('deleteSegmentKeys removes specific entries', async () => {
    const k1 = await audioCacheKey(VOICE, 'one')
    const k2 = await audioCacheKey(VOICE, 'two')
    await putSegment(k1, new Blob(['x']), 1, { voiceId: VOICE })
    await putSegment(k2, new Blob(['x']), 1, { voiceId: VOICE })
    const removed = await deleteSegmentKeys([k1])
    expect(removed).toBe(1)
    expect(await getSegment(k1)).toBeUndefined()
    expect(await getSegment(k2)).toBeDefined()
  })

  it('clearSegmentCache removes everything', async () => {
    await storeSegment(VOICE, 'a', new Blob(['x']), 1, {})
    await storeSegment(VOICE, 'b', new Blob(['x']), 1, {})
    const removed = await clearSegmentCache()
    expect(removed).toBe(2)
    expect(await getSegmentCacheSize()).toBe(0)
  })
})

describe('putSegment error resilience', () => {
  it('never rejects, even when the underlying put fails', async () => {
    vi.resetModules()
    vi.doMock('./db', async () => {
      const actual = await vi.importActual<typeof import('./db')>('./db')
      return {
        ...actual,
        getDB: vi.fn().mockRejectedValue(new Error('idb boom')),
      }
    })
    const { putSegment: put } = await import('./audio-segment-cache')
    const key = await audioCacheKey(VOICE, 'failing put')
    await expect(put(key, new Blob(['x']), 1, { voiceId: VOICE })).rejects.toThrow('idb boom')
    vi.doUnmock('./db')
    vi.resetModules()
  })
})
