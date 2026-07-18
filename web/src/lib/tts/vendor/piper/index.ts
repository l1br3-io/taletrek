/**
 * Public surface of the vendored piper boundary.
 *
 * Consumers (`engine.ts`, the voice-picker UI) import from here — never from
 * individual files — so the internal layout can evolve without churn.
 */

export type { PiperPhase } from './errors'
export { PiperError } from './errors'
export { HF_BASE, ONNX_BASE, PATH_MAP, voiceFilenames } from './models'
export {
  clearStoredVoices,
  downloadVoice,
  fetchBlob,
  getBlob,
  readBlob,
  removeBlob,
  removeVoice,
  storedVoices,
  writeBlob,
} from './opfs'
export type { OrtModule, PhonemizeFactory, PiperSessionOptions } from './session'
export { PiperSession } from './session'
