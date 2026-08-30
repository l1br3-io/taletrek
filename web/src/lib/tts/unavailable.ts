import type { TtsEngine } from './types'

/**
 * Engine stub for the post-pivot reader (ADR-0015): on-device synthesis was
 * removed — audio arrives inside imported `.taletrek` bundles. The players
 * keep the `TtsEngine` seam (a cache miss asks the engine to synthesize);
 * this stub turns any miss into an explicit error instead.
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

export const unavailableEngine: TtsEngine = {
  listVoices: () => refuse(),
  isStored: () => refuse(),
  download: () => refuse(),
  synthesize: () => refuse(),
  remove: () => refuse(),
  clearAllStored: () => refuse(),
}
