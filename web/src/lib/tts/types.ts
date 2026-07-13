import type { BookId, VoiceId } from '../../types'

export type VoiceQuality = 'low' | 'medium' | 'high'

export interface Voice {
  /** Package voice key, e.g. `en_US-hfc_female-medium`. */
  id: VoiceId
  /** Short human-readable display name, e.g. `HFC Female`. */
  name: string
  quality: VoiceQuality
  /** Approximate model `.onnx` size in bytes (for UI affordance). */
  sizeBytes: number
  /** BCP-47-style locale code, e.g. `en_US`. */
  language: string
}

export interface SynthesisRequest {
  text: string
  voiceId: VoiceId
  /**
   * Optional: the book this paragraph belongs to. Threaded through to the
   * audio cache (M8) so `deleteBookCascade` reclaims the entry. When omitted,
   * the audio is still cached but only LRU-reapable (no per-book cascade).
   */
  bookId?: BookId
}

export interface SynthesisResult {
  /** WAV audio (22050 Hz mono 16-bit per the Piper spike). */
  audio: Blob
  /** Wall-clock synthesis time in milliseconds, for diagnostics. */
  synthMs: number
}

/**
 * Text-to-speech engine contract. Defined before the concrete implementation
 * so playback depends on the interface, not the Piper package — keeping the
 * engine swappable and unit-testable with a stub.
 *
 * The concrete engine wraps `@mintplex-labs/piper-tts-web`; voice models are
 * fetched on demand and cached in OPFS by the package.
 */
export interface TtsEngine {
  /** Return the curated voice catalog (static — no network). */
  listVoices(): Promise<Voice[]>
  /** Whether the model for a voice is already downloaded to OPFS. */
  isStored(voiceId: VoiceId): Promise<boolean>
  /** Download a voice model to OPFS, reporting progress as a 0–1 fraction. */
  download(voiceId: VoiceId, onProgress?: (fraction: number) => void): Promise<void>
  /** Synthesize text → WAV. Loads the model on first use (cold ~4s, warm ~1s). */
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>
  /** Remove a downloaded voice model from OPFS. */
  remove(voiceId: VoiceId): Promise<void>
}
