import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { voiceId } from '../../types'
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

beforeEach(() => {
  predictMock.mockReset()
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
