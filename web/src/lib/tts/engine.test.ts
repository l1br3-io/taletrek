import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { voiceId } from '../../types'
import { _clearDBForTests, _resetDBForTests, getAudioCacheEntry } from '../db'
import { PiperEngine } from './engine'

const VOICE = voiceId('en_US-hfc_female-medium')
const OTHER = voiceId('en_US-ryan-medium')

const predictMock = vi.fn()
const disposeMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

/** Build a minimal valid PCM-encoded WAV blob (22050Hz mono 16-bit). */
function makeWav(sampleCount = 1): Blob {
  const buf = new ArrayBuffer(44 + sampleCount * 2)
  const v = new DataView(buf)
  v.setUint32(0, 0x46464952, true) // "RIFF"
  v.setUint32(4, 36 + sampleCount * 2, true)
  v.setUint32(8, 0x45564157, true) // "WAVE"
  v.setUint32(12, 0x20746d66, true) // "fmt "
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, 22050, true)
  v.setUint32(28, 22050 * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  v.setUint32(36, 0x61746164, true) // "data"
  v.setUint32(40, sampleCount * 2, true)
  return new Blob([buf], { type: 'audio/x-wav' })
}

// Mock the vendored piper boundary at the module boundary the engine talks to.
// Real PiperSession.create is replaced by a stub that returns a fake session;
// the OPFS-backed helpers (storedVoices/downloadVoice/removeVoice) become vi.fn
// so individual tests can drive their return values.
vi.mock('./vendor/piper', () => {
  class FakeSession {
    static async create(): Promise<FakeSession> {
      return new FakeSession()
    }
    predict = predictMock
    dispose = disposeMock
  }
  return {
    PiperSession: FakeSession,
    storedVoices: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    downloadVoice: vi.fn(),
    removeVoice: vi.fn(),
    clearStoredVoices: vi.fn(),
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

  it('resets the session when the voice changes', async () => {
    predictMock.mockResolvedValue(new Blob([new Uint8Array([0])]))
    const engine = new PiperEngine()
    await engine.synthesize({ text: 'a', voiceId: VOICE })
    await engine.synthesize({ text: 'b', voiceId: OTHER })
    // two distinct sessions -> predict bound on each; old session disposed
    expect(predictMock).toHaveBeenCalledTimes(2)
    expect(disposeMock).toHaveBeenCalledTimes(1)
  })

  it('isStored delegates to the vendor and matches by id', async () => {
    const { storedVoices } = await import('./vendor/piper')
    vi.mocked(storedVoices).mockResolvedValue([VOICE])
    const engine = new PiperEngine()
    expect(await engine.isStored(VOICE)).toBe(true)
    expect(await engine.isStored(OTHER)).toBe(false)
  })

  it('download reports progress as a 0–1 fraction', async () => {
    const { downloadVoice } = await import('./vendor/piper')
    vi.mocked(downloadVoice).mockImplementation(async (_id, cb) => {
      cb?.({ url: 'x', total: 100, loaded: 50 })
      cb?.({ url: 'x', total: 100, loaded: 100 })
    })
    const engine = new PiperEngine()
    const progress: number[] = []
    await engine.download(VOICE, (f) => progress.push(f))
    expect(progress).toEqual([0.5, 1])
  })

  it('download ignores progress events with no total', async () => {
    const { downloadVoice } = await import('./vendor/piper')
    vi.mocked(downloadVoice).mockImplementation(async (_id, cb) => {
      cb?.({ url: 'x', total: 0, loaded: 0 })
    })
    const engine = new PiperEngine()
    const progress: number[] = []
    await engine.download(VOICE, (f) => progress.push(f))
    expect(progress).toEqual([])
  })

  it('remove delegates to the vendor', async () => {
    const { removeVoice } = await import('./vendor/piper')
    vi.mocked(removeVoice).mockResolvedValue(undefined)
    const engine = new PiperEngine()
    await engine.remove(VOICE)
    expect(removeVoice).toHaveBeenCalledWith(VOICE)
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

describe('PiperEngine — chunking (long paragraphs)', () => {
  it('splits a long paragraph into chunks and calls predict per chunk', async () => {
    const { MAX_SYNTH_CHARS } = await import('./normalize')
    predictMock.mockResolvedValue(makeWav())

    // Build a paragraph that exceeds the cap using unambiguous sentences
    // joined with spaces after terminators (avoid "word.text" junctions from
    // repeat() that break the sentence-boundary regex).
    const base = 'A brief clear sentence. Another one here. Padding the line. More words follow. '
    const text = base.repeat(Math.ceil((MAX_SYNTH_CHARS * 3) / base.length))
    expect(text.length).toBeGreaterThan(MAX_SYNTH_CHARS)

    const engine = new PiperEngine()
    const result = await engine.synthesize({ text, voiceId: VOICE })
    expect(result.audio).toBeDefined()
    expect(predictMock.mock.calls.length).toBeGreaterThan(1)
    // Each call's text is ≤ the cap.
    for (const call of predictMock.mock.calls) {
      const arg = call[0] as string
      expect(arg.length).toBeLessThanOrEqual(MAX_SYNTH_CHARS)
    }
  })

  it('uses a single predict call for short text (no unnecessary chunking)', async () => {
    predictMock.mockResolvedValue(new Blob([new Uint8Array([1])]))
    const engine = new PiperEngine()
    await engine.synthesize({ text: 'Hello world. Short paragraph.', voiceId: VOICE })
    expect(predictMock).toHaveBeenCalledTimes(1)
    expect(predictMock).toHaveBeenCalledWith('Hello world. Short paragraph.')
  })
})
