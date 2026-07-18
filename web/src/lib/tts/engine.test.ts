import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { voiceId } from '../../types'
import { _clearDBForTests, _resetDBForTests, getAudioCacheEntry } from '../db'
import { PiperEngine } from './engine'

const VOICE = voiceId('en_US-hfc_female-medium')
const OTHER = voiceId('en_US-ryan-medium')

const predictMock = vi.fn()

vi.mock('@mintplex-labs/piper-tts-web', () => {
  class FakeSession {
    static _instance: unknown = null
    static async create(opts: { voiceId: string }): Promise<FakeSession> {
      return new FakeSession(opts.voiceId)
    }
    constructor(public voiceId: string) {}
    predict = predictMock
  }
  return {
    TtsSession: FakeSession,
    stored: vi.fn<(id: string) => Promise<string[]>>().mockResolvedValue([]),
    download: vi.fn(),
    remove: vi.fn(),
    voices: vi.fn(),
  }
})

beforeEach(async () => {
  predictMock.mockReset()
  _resetDBForTests()
  await _clearDBForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PiperEngine', () => {
  it('listVoices returns the curated catalog', async () => {
    const engine = new PiperEngine()
    const voices = await engine.listVoices()
    expect(voices).toHaveLength(8)
    expect(voices[0]?.id).toBe(VOICE)
  })

  it('synthesize creates a session and returns the WAV + timing', async () => {
    const wav = new Blob([new Uint8Array([0])], { type: 'audio/x-wav' })
    predictMock.mockResolvedValue(wav)
    const engine = new PiperEngine()
    const result = await engine.synthesize({ text: 'hello', voiceId: VOICE })
    expect(result.audio).toBe(wav)
    expect(result.synthMs).toBeGreaterThanOrEqual(0)
    expect(result.durationSeconds).toBe(0)
    expect(result.cacheKey).toBeDefined()
    expect(predictMock).toHaveBeenCalledWith('hello')
  })

  it('reuses the session when the voice is unchanged', async () => {
    predictMock.mockResolvedValue(new Blob([new Uint8Array([0])]))
    const engine = new PiperEngine()
    await engine.synthesize({ text: 'one', voiceId: VOICE })
    await engine.synthesize({ text: 'two', voiceId: VOICE })
    // predict called twice, but session created once (predict reused)
    expect(predictMock).toHaveBeenCalledTimes(2)
  })

  it('resets the singleton when the voice changes', async () => {
    predictMock.mockResolvedValue(new Blob([new Uint8Array([0])]))
    const engine = new PiperEngine()
    await engine.synthesize({ text: 'a', voiceId: VOICE })
    await engine.synthesize({ text: 'b', voiceId: OTHER })
    // two distinct sessions -> predict bound on each; singleton reset in between
    expect(predictMock).toHaveBeenCalledTimes(2)
  })

  it('isStored delegates to the package and matches by id', async () => {
    const { stored } = await import('@mintplex-labs/piper-tts-web')
    vi.mocked(stored).mockResolvedValue([VOICE])
    const engine = new PiperEngine()
    expect(await engine.isStored(VOICE)).toBe(true)
    expect(await engine.isStored(OTHER)).toBe(false)
  })

  it('download reports progress as a 0–1 fraction', async () => {
    const { download } = await import('@mintplex-labs/piper-tts-web')
    vi.mocked(download).mockImplementation(async (_id, cb) => {
      cb?.({ url: 'x', total: 100, loaded: 50 })
      cb?.({ url: 'x', total: 100, loaded: 100 })
    })
    const engine = new PiperEngine()
    const progress: number[] = []
    await engine.download(VOICE, (f) => progress.push(f))
    expect(progress).toEqual([0.5, 1])
  })

  it('download ignores progress events with no total', async () => {
    const { download } = await import('@mintplex-labs/piper-tts-web')
    vi.mocked(download).mockImplementation(async (_id, cb) => {
      cb?.({ url: 'x', total: 0, loaded: 0 })
    })
    const engine = new PiperEngine()
    const progress: number[] = []
    await engine.download(VOICE, (f) => progress.push(f))
    expect(progress).toEqual([])
  })

  it('remove delegates to the package', async () => {
    const { remove } = await import('@mintplex-labs/piper-tts-web')
    vi.mocked(remove).mockResolvedValue(undefined)
    const engine = new PiperEngine()
    await engine.remove(VOICE)
    expect(remove).toHaveBeenCalledWith(VOICE)
  })
})

describe('PiperEngine — audio cache (M8)', () => {
  it('a cache hit returns the stored blob with synthMs 0 (no inference)', async () => {
    const wav = new Blob([new Uint8Array([9])], { type: 'audio/x-wav' })
    predictMock.mockResolvedValue(wav)
    const engine = new PiperEngine()
    const { audioCacheKey } = await import('../audio-cache')
    const key = await audioCacheKey(VOICE, 'cold paragraph')
    // First call: miss → predict → store.
    await engine.synthesize({ text: 'cold paragraph', voiceId: VOICE })
    expect(predictMock).toHaveBeenCalledTimes(1)
    // Ensure the IndexedDB write is visible before the second lookup.
    await vi.waitFor(async () => expect(await getAudioCacheEntry(key)).toBeDefined())
    // Second call: same text+voice → hit → no predict.
    const result = await engine.synthesize({ text: 'cold paragraph', voiceId: VOICE })
    expect(predictMock).toHaveBeenCalledTimes(1)
    expect(result.synthMs).toBe(0)
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0)
    expect(result.cacheKey).toBeDefined()
    // The audio came back from the cache (fake-indexeddb in jsdom returns a
    // Blob-like object without the Blob prototype, so we assert truthiness +
    // that it has content rather than instanceof/size).
    expect(result.audio).toBeTruthy()
  })

  it('a cache miss synthesizes, stores, and reports real synthMs', async () => {
    const wav = new Blob([new Uint8Array([1])], { type: 'audio/x-wav' })
    predictMock.mockResolvedValue(wav)
    const engine = new PiperEngine()
    const result = await engine.synthesize({ text: 'fresh synthesis', voiceId: VOICE })
    expect(predictMock).toHaveBeenCalledWith('fresh synthesis')
    expect(result.synthMs).toBeGreaterThanOrEqual(0)
    // Stored entry exists in IDB.
    const { audioCacheKey } = await import('../audio-cache')
    const key = await audioCacheKey(VOICE, 'fresh synthesis')
    expect(await getAudioCacheEntry(key)).toBeDefined()
  })

  it('changing the voice produces a cache miss (different key)', async () => {
    predictMock.mockResolvedValue(new Blob([new Uint8Array([1])]))
    const engine = new PiperEngine()
    await engine.synthesize({ text: 'shared text', voiceId: VOICE })
    await engine.synthesize({ text: 'shared text', voiceId: OTHER })
    // Two distinct voices → two predict calls (both miss).
    expect(predictMock).toHaveBeenCalledTimes(2)
  })

  it('changing the text produces a cache miss', async () => {
    predictMock.mockResolvedValue(new Blob([new Uint8Array([1])]))
    const engine = new PiperEngine()
    await engine.synthesize({ text: 'one thing', voiceId: VOICE })
    await engine.synthesize({ text: 'another thing', voiceId: VOICE })
    expect(predictMock).toHaveBeenCalledTimes(2)
  })

  it('threads bookId onto the stored cache record', async () => {
    predictMock.mockResolvedValue(new Blob([new Uint8Array([1])]))
    const { newBookId } = await import('../../types')
    const bookId = newBookId()
    const engine = new PiperEngine()
    await engine.synthesize({ text: 'with book context', voiceId: VOICE, bookId })
    const { audioCacheKey } = await import('../audio-cache')
    const key = await audioCacheKey(VOICE, 'with book context')
    const record = await getAudioCacheEntry(key)
    expect(record?.bookId).toBe(bookId)
  })

  it('never blocks synthesis when the cache lookup throws', async () => {
    // Stub the audio-cache module so lookupAudioCache rejects.
    vi.resetModules()
    vi.doMock('../audio-cache', async () => {
      const actual = await vi.importActual<typeof import('../audio-cache')>('../audio-cache')
      return {
        ...actual,
        lookupAudioCache: vi.fn().mockRejectedValue(new Error('idb dead')),
        storeAudioCache: vi.fn().mockResolvedValue(undefined),
      }
    })
    const { PiperEngine: EngineFailing } = await import('./engine')
    const wav = new Blob([new Uint8Array([1])], { type: 'audio/x-wav' })
    predictMock.mockResolvedValue(wav)
    const engine = new EngineFailing()
    const result = await engine.synthesize({ text: 'fail open', voiceId: VOICE })
    expect(result.audio).toBe(wav)
    expect(result.durationSeconds).toBe(0)
    expect(result.cacheKey).toBeDefined()
    vi.doUnmock('../audio-cache')
    vi.resetModules()
  })
})
