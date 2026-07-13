import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newBookId, voiceId } from '../types'
import { audioCacheKey, lookupAudioCache, storeAudioCache } from './audio-cache'
import { _clearDBForTests, _resetDBForTests } from './db'
import { NORM_VERSION, normalizeForSpeech } from './tts/normalize'

const VOICE = voiceId('en_US-hfc_female-medium')
const OTHER = voiceId('en_US-ryan-medium')

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('audioCacheKey', () => {
  it('is deterministic for the same voice + text', async () => {
    const a = await audioCacheKey(VOICE, 'hello world')
    const b = await audioCacheKey(VOICE, 'hello world')
    expect(a).toBe(b)
  })

  it('changes when the voice changes', async () => {
    const a = await audioCacheKey(VOICE, 'hello')
    const b = await audioCacheKey(OTHER, 'hello')
    expect(a).not.toBe(b)
  })

  it('embeds NORM_VERSION so a bump invalidates the whole cache', async () => {
    const v1 = await audioCacheKey(VOICE, 'hello', '1')
    const v2 = await audioCacheKey(VOICE, 'hello', '2')
    expect(v1).not.toBe(v2)
    expect(v1.startsWith(`${VOICE}:1:`)).toBe(true)
    expect(v2.startsWith(`${VOICE}:2:`)).toBe(true)
  })

  it('hashes the normalized text, so whitespace-only differences collapse', async () => {
    const raw = 'too   much\t\nspace'
    const collapsed = normalizeForSpeech(raw)
    expect(collapsed).toBe('too much space')
    const a = await audioCacheKey(VOICE, raw)
    const b = await audioCacheKey(VOICE, collapsed)
    expect(a).toBe(b)
  })

  it('changes when the (normalized) text changes', async () => {
    const a = await audioCacheKey(VOICE, 'hello')
    const b = await audioCacheKey(VOICE, 'world')
    expect(a).not.toBe(b)
  })

  it('the default NORM_VERSION is the exported constant', async () => {
    const key = await audioCacheKey(VOICE, 'x')
    expect(key.startsWith(`${VOICE}:${NORM_VERSION}:`)).toBe(true)
  })
})

describe('lookupAudioCache / storeAudioCache', () => {
  it('returns undefined on miss', async () => {
    const key = await audioCacheKey(VOICE, 'never synthesized')
    expect(await lookupAudioCache(key)).toBeUndefined()
  })

  it('round-trips a blob through store then lookup', async () => {
    const key = await audioCacheKey(VOICE, 'paragraph one')
    const wav = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/x-wav' })
    await storeAudioCache(key, wav, { voiceId: VOICE, synthMs: 950 })
    const hit = await lookupAudioCache(key)
    expect(hit).toBeDefined()
    expect(hit?.blob).toBeDefined()
    expect(hit?.sizeBytes).toBe(wav.size)
    expect(hit?.voiceId).toBe(VOICE)
    expect(hit?.synthMs).toBe(950)
  })

  it('threads bookId onto the record when provided', async () => {
    const bookId = newBookId()
    const key = await audioCacheKey(VOICE, 'with book')
    await storeAudioCache(key, new Blob(['x']), { bookId, voiceId: VOICE, synthMs: 1 })
    const hit = await lookupAudioCache(key)
    expect(hit?.bookId).toBe(bookId)
  })

  it('omits bookId when not provided (no cascade clear, LRU only)', async () => {
    const key = await audioCacheKey(VOICE, 'no book')
    await storeAudioCache(key, new Blob(['x']), { voiceId: VOICE, synthMs: 1 })
    const hit = await lookupAudioCache(key)
    expect(hit?.bookId).toBeUndefined()
  })

  it('storeAudioCache never rejects, even when the underlying put fails', async () => {
    // Mock the db module so putAudioCacheEntry rejects. vi.mock is hoisted;
    // we keep getAudioCacheEntry real-ish (unused here) and only fail puts.
    vi.resetModules()
    vi.doMock('./db', async () => {
      const actual = await vi.importActual<typeof import('./db')>('./db')
      return {
        ...actual,
        putAudioCacheEntry: vi.fn().mockRejectedValue(new Error('idb boom')),
      }
    })
    const { storeAudioCache: store } = await import('./audio-cache')
    const key = await audioCacheKey(VOICE, 'failing put')
    await expect(
      store(key, new Blob(['x']), { voiceId: VOICE, synthMs: 1 }),
    ).resolves.toBeUndefined()
    vi.doUnmock('./db')
    vi.resetModules()
  })
})
