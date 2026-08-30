import { beforeEach, describe, expect, it } from 'vitest'
import { voiceId } from '../../types'
import { audioCacheKey, storeAudioCache } from '../audio-cache'
import { _clearDBForTests, _resetDBForTests } from '../db'
import { unavailableEngine } from './unavailable'

const VOICE = voiceId('en_US-lessac-medium')

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('unavailableEngine.synthesize (the post-pivot playback seam)', () => {
  it('serves a persistent-cache hit — imported bundles must play (G22)', async () => {
    const text = 'Hello world.'
    const wav = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/ogg' })
    const key = await audioCacheKey(VOICE, text)
    await storeAudioCache(key, wav, { voiceId: VOICE, synthMs: 1, durationSeconds: 2.5 })

    const result = await unavailableEngine.synthesize({ text, voiceId: VOICE })
    // fake-indexeddb's structured clone mangles Blob instances (plain object),
    // so assert the record is served — key + duration + audio — not Blob shape.
    expect(result.audio).toBeDefined()
    expect(result.cacheKey).toBe(key)
    expect(result.durationSeconds).toBe(2.5)
  })

  it('throws the explicit ADR-0015 error on a cache miss', async () => {
    await expect(
      unavailableEngine.synthesize({ text: 'not cached', voiceId: VOICE }),
    ).rejects.toThrow(/ADR-0015/)
  })

  it('keys the lookup by the requested voice — another voice is a miss', async () => {
    const text = 'Hello world.'
    const key = await audioCacheKey(VOICE, text)
    await storeAudioCache(key, new Blob(['x']), { voiceId: VOICE, synthMs: 1, durationSeconds: 1 })

    const other = voiceId('en_US-ryan-medium')
    await expect(unavailableEngine.synthesize({ text, voiceId: other })).rejects.toThrow(/ADR-0015/)
  })
})

describe('unavailableEngine non-synth methods', () => {
  it('still refuse — no voice management post-pivot', async () => {
    // The refusals throw synchronously; the async wrapper converts that to a
    // rejection so `rejects` can assert it.
    const call = async (f: () => unknown) => f()
    await expect(call(() => unavailableEngine.listVoices())).rejects.toThrow(/ADR-0015/)
    await expect(call(() => unavailableEngine.isStored(VOICE))).rejects.toThrow(/ADR-0015/)
    await expect(call(() => unavailableEngine.download(VOICE))).rejects.toThrow(/ADR-0015/)
    await expect(call(() => unavailableEngine.remove(VOICE))).rejects.toThrow(/ADR-0015/)
    await expect(call(() => unavailableEngine.clearAllStored())).rejects.toThrow(/ADR-0015/)
  })
})
