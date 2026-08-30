import { audioCacheKey, lookupAudioCache } from '../audio-cache'
import type { SynthesisRequest, TtsEngine } from './types'

/**
 * Engine seam for the post-pivot reader (ADR-0015): on-device synthesis was
 * removed — audio arrives inside imported `.taletrek` bundles. The players
 * fetch every paragraph through the `TtsEngine` seam, so `synthesize` is the
 * persistent-cache read path: a hit returns the imported blob; a miss throws
 * the explicit error (G22 — no re-synth). Voice management stays refused.
 */
class SynthesisUnavailableError extends Error {
  constructor() {
    super('Synthesis unavailable — this build plays imported bundles only (ADR-0015).')
    this.name = 'SynthesisUnavailableError'
  }
}

function refuse(): never {
  throw new SynthesisUnavailableError()
}

async function synthesizeFromCache(req: SynthesisRequest) {
  const key = await audioCacheKey(req.voiceId, req.text)
  const hit = await lookupAudioCache(key)
  if (!hit) throw new SynthesisUnavailableError()
  return {
    ...(req.returnAudio === true ? {} : { audio: hit.blob }),
    synthMs: 0,
    durationSeconds: hit.durationSeconds,
    cacheKey: key,
  }
}

export const unavailableEngine: TtsEngine = {
  listVoices: () => refuse(),
  isStored: () => refuse(),
  download: () => refuse(),
  synthesize: synthesizeFromCache,
  remove: () => refuse(),
  clearAllStored: () => refuse(),
}
