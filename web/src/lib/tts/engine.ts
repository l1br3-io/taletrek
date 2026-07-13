import * as piper from '@mintplex-labs/piper-tts-web'
import type { VoiceId } from '../../types'
import { audioCacheKey, lookupAudioCache, storeAudioCache } from '../audio-cache'
import { normalizeForSpeech } from './normalize'
import type { SynthesisRequest, SynthesisResult, TtsEngine, Voice } from './types'
import { CURATED_VOICES } from './voices'
import { WASM_PATHS } from './wasm-paths'

/**
 * Concrete `TtsEngine` wrapping `@mintplex-labs/piper-tts-web`. Runs inside the
 * TTS Web Worker so inference never blocks the UI thread.
 *
 * `TtsSession` is a package-level singleton: `wasmPaths` only takes effect on
 * the first construction, and `init()` loads exactly one model. To switch
 * voices we clear the singleton and create a fresh session (the old model is
 * GC'd). Cold synth ≈ 4s (model load); warm ≈ 1s.
 *
 * M8: `synthesize` is backed by a persistent content-addressed IndexedDB cache
 * (`audioCache` store). On a cache hit the audio is returned from IDB without
 * running Piper inference, so resume-after-reload is near-instant. The cache
 * key is `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`; see
 * `lib/audio-cache.ts`. Cache misses store the result after synthesis.
 */
export class PiperEngine implements TtsEngine {
  private session: piper.TtsSession | null = null
  private loadedVoiceId: VoiceId | null = null

  async listVoices(): Promise<Voice[]> {
    return [...CURATED_VOICES]
  }

  async isStored(voiceId: VoiceId): Promise<boolean> {
    const stored = await piper.stored()
    return stored.includes(voiceId)
  }

  async download(voiceId: VoiceId, onProgress?: (fraction: number) => void): Promise<void> {
    await piper.download(voiceId, (p) => {
      if (p.total > 0) onProgress?.(p.loaded / p.total)
    })
  }

  async remove(voiceId: VoiceId): Promise<void> {
    await piper.remove(voiceId)
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    // M8: content-addressed cache check first. A hit returns the stored WAV
    // without running Piper inference — resume-after-reload is near-instant.
    // Failures here must never block synthesis; we fail open.
    const key = await audioCacheKey(req.voiceId, req.text)
    try {
      const hit = await lookupAudioCache(key)
      if (hit) return { audio: hit.blob, synthMs: 0 }
    } catch {
      // Cache lookup must never block synthesis — fail open.
    }

    const session = await this.sessionFor(req.voiceId)
    const t0 = performance.now()
    const audio = await session.predict(normalizeForSpeech(req.text))
    const synthMs = performance.now() - t0

    // Best-effort store; failures are swallowed inside `storeAudioCache`.
    void storeAudioCache(key, audio, {
      voiceId: req.voiceId,
      synthMs,
      ...(req.bookId !== undefined ? { bookId: req.bookId } : {}),
    })

    return { audio, synthMs }
  }

  /** Return a session bound to `voiceId`, creating a fresh one on voice change. */
  private async sessionFor(voiceId: VoiceId): Promise<piper.TtsSession> {
    if (this.session && this.loadedVoiceId === voiceId) return this.session
    // Reset the package singleton so a new model loads for the new voice.
    piper.TtsSession._instance = null
    this.session = await piper.TtsSession.create({
      voiceId,
      wasmPaths: WASM_PATHS,
    })
    this.loadedVoiceId = voiceId
    return this.session
  }
}
