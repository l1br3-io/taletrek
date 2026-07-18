import type { BookId, VoiceId } from '../../types'
import { parseWavDuration } from '../audio/ffmpeg'
import { audioCacheKey, lookupAudioCache, storeAudioCache } from '../audio-cache'
import { MAX_SYNTH_CHARS, normalizeForSpeech, splitForSpeech } from './normalize'
import type { SynthesisRequest, SynthesisResult, TtsEngine, Voice } from './types'
import {
  clearStoredVoices,
  downloadVoice,
  PiperSession,
  removeVoice,
  storedVoices,
} from './vendor/piper'
import { concatWav } from './vendor/piper/pcm'
import { CURATED_VOICES } from './voices'
import { WASM_PATHS } from './wasm-paths'

async function durationFromBlob(blob: Blob): Promise<number> {
  return parseWavDuration(await blob.arrayBuffer())
}

/** Minimal session surface the engine depends on (decoupled from the vendor). */
interface PiperSessionLike {
  predict(text: string): Promise<Blob>
  dispose(): Promise<void>
}

/** Injectable factory — tests pass a stub; production uses the real vendor. */
export type PiperSessionFactory = (voiceId: VoiceId) => Promise<PiperSessionLike>

const defaultSessionFactory: PiperSessionFactory = async (voiceId) =>
  PiperSession.create({ voiceId, wasmPaths: WASM_PATHS })

/**
 * Concrete `TtsEngine` wrapping the vendored Piper boundary. Runs inside the
 * TTS Web Worker so inference never blocks the UI thread.
 *
 * One session = one loaded voice model. Switching voices disposes the old
 * session and creates a new one (the old model's WASM memory is released via
 * `session.dispose()` and GC'd).
 *
 * M8: `synthesize` is backed by a persistent content-addressed IndexedDB
 * cache (`audioCache` store). On a cache hit the audio is returned from IDB
 * without running Piper inference, so resume-after-reload is near-instant.
 * The cache key is `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`;
 * see `lib/audio-cache.ts`. Cache misses store the result after synthesis.
 *
 * The session factory is injectable so the engine is unit-testable without
 * spinning up real WASM/ORT — see `engine.test.ts`.
 */
export class PiperEngine implements TtsEngine {
  private session: PiperSessionLike | null = null
  private loadedVoiceId: VoiceId | null = null

  constructor(private readonly createSession: PiperSessionFactory = defaultSessionFactory) {}

  async listVoices(): Promise<Voice[]> {
    return [...CURATED_VOICES]
  }

  async isStored(voiceId: VoiceId): Promise<boolean> {
    const stored = await storedVoices()
    return stored.includes(voiceId)
  }

  async download(voiceId: VoiceId, onProgress?: (fraction: number) => void): Promise<void> {
    await downloadVoice(voiceId, (p) => {
      if (p.total > 0) onProgress?.(p.loaded / p.total)
    })
  }

  async remove(voiceId: VoiceId): Promise<void> {
    await removeVoice(voiceId)
  }

  async clearAllStored(): Promise<void> {
    await clearStoredVoices()
  }

  /**
   * Drop the cached session so the next `synthesize` re-creates it from
   * scratch (re-loading the model + re-initializing Emscripten MEMFS).
   * Called by the worker's `resetEngine` handler after a fatal worker-level
   * error — typically `NotFoundError: Object cannot be found here` from
   * Emscripten MEMFS when `/espeak-ng-data` has disappeared from the
   * virtual FS, leaving phonemize permanently broken.
   *
   * The disposed session's WASM memory is left to GC — `dispose()` releases
   * the ORT InferenceSession eagerly (the cheap, deterministic bit); the
   * Emscripten module memory follows on the next GC pass. On iOS this can
   * briefly raise memory pressure before GC runs, but recycling is rare
   * (only on fatal errors) and the alternative — keeping a broken session
   * forever — is strictly worse.
   */
  recycle(): void {
    console.log('[taletrek] engine: recycling session', {
      hadSession: this.session !== null,
      loadedVoiceId: this.loadedVoiceId,
    })
    this.session?.dispose().catch(() => {})
    this.session = null
    this.loadedVoiceId = null
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    // M8: content-addressed cache check first. A hit returns the stored WAV
    // without running Piper inference — resume-after-reload is near-instant.
    // Failures here must never block synthesis; we fail open.
    const key = await audioCacheKey(req.voiceId, req.text)
    try {
      const hit = await lookupAudioCache(key)
      if (hit) {
        const durationSeconds =
          hit.durationSeconds ?? (await durationFromBlob(hit.blob).catch(() => 0))
        return {
          audio: req.returnAudio === false ? undefined : hit.blob,
          synthMs: 0,
          durationSeconds,
          cacheKey: key,
        }
      }
    } catch {
      // Cache lookup must never block synthesis — fail open.
    }

    const session = await this.sessionFor(req.voiceId)
    const t0 = performance.now()
    const cleaned = normalizeForSpeech(req.text)

    // Long paragraphs (PDF extraction artifact — pdfjs merges visual paragraphs
    // when the source lacks blank-line separation) produce phoneme sequences
    // that OOM the ONNX VITS inference on iOS Safari's worker. Split at
    // sentence boundaries to bound peak memory per inference call. Cache key
    // is derived from the FULL normalized text, so cache hits skip this entirely.
    const chunks = splitForSpeech(cleaned)
    let audio: Blob
    if (chunks.length <= 1) {
      const single = chunks[0] ?? cleaned
      console.log('[taletrek] engine: predicting for', single.length, 'chars')
      audio = await this.predictWithLogging(session, single)
    } else {
      console.log(
        '[taletrek] engine: chunking',
        chunks.length,
        'chunks for',
        cleaned.length,
        'chars (cap',
        MAX_SYNTH_CHARS,
        ', avg',
        Math.round(cleaned.length / chunks.length),
        ')',
      )
      const wavs: ArrayBuffer[] = []
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] ?? cleaned
        console.log(
          '[taletrek] engine: predicting chunk',
          i + 1,
          '/',
          chunks.length,
          '(',
          chunk.length,
          'chars)',
        )
        const blob = await this.predictWithLogging(session, chunk)
        wavs.push(await blob.arrayBuffer())
      }
      const merged = concatWav(wavs)
      audio = new Blob([merged], { type: 'audio/x-wav' })
      console.log('[taletrek] engine: chunked concat done', audio.size, 'bytes')
    }

    const synthMs = performance.now() - t0
    console.log(
      '[taletrek] engine: predict done in',
      Math.round(synthMs),
      'ms, blob size',
      audio.size,
    )
    const durationSeconds = await durationFromBlob(audio)
    console.log('[taletrek] engine: duration', durationSeconds.toFixed(2), 's')

    void storeAudioCache(key, audio, {
      voiceId: req.voiceId,
      synthMs,
      durationSeconds,
      ...(req.bookId !== undefined ? { bookId: req.bookId as BookId } : {}),
    })

    return {
      audio: req.returnAudio === false ? undefined : audio,
      synthMs,
      durationSeconds,
      cacheKey: key,
    }
  }

  /**
   * Drive `session.predict` with consistent error logging. Extracted so the
   * chunking path and the single-call path both surface failures identically.
   */
  private async predictWithLogging(session: PiperSessionLike, text: string): Promise<Blob> {
    try {
      return await session.predict(text)
    } catch (err) {
      console.error('[taletrek] engine: predict failed', {
        errName: (err as Error).name,
        errCode: (err as DOMException).code,
        errConstructor: (err as object).constructor?.name,
        message: (err as Error).message,
        phase: (err as { phase?: string }).phase,
        textLen: text.length,
      })
      throw err
    }
  }

  /** Return a session bound to `voiceId`, creating a fresh one on voice change. */
  private async sessionFor(voiceId: VoiceId): Promise<PiperSessionLike> {
    if (this.session && this.loadedVoiceId === voiceId) return this.session
    // Voice changed (or first call): dispose the old session before loading
    // the new model — bounds peak memory on iOS where two simultaneous models
    // can trip OOM.
    this.session?.dispose().catch(() => {})
    this.session = await this.createSession(voiceId)
    this.loadedVoiceId = voiceId
    return this.session
  }
}
