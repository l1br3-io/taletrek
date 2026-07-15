import type { BookId, Chapter, VoiceId } from '../types'
import { parseWavDuration } from './audio/ffmpeg'
import { audioCacheKey } from './audio-cache'
import type { TtsEngine } from './tts/types'

export interface PreSynthOptions {
  bookId: BookId
  chapters: Chapter[]
  voiceId: VoiceId
  engine: TtsEngine
  onProgress?: (done: number, total: number) => void
  onVoiceDownload?: (fraction: number) => void
  /** Abort the run cooperatively — checked between paragraphs. */
  signal?: AbortSignal
}

export interface ParagraphPreSynthInfo {
  /** Content-addressed audioCache key for this paragraph's WAV. */
  cacheKey: string
  /** Audio duration in seconds, parsed from the synthesised WAV. */
  durationSeconds: number
}

export interface PreSynthResult {
  total: number
  synthesized: number
  cached: number
  cancelled: boolean
  /** Per-paragraph cache keys and durations, in flatten order. */
  paragraphs: ParagraphPreSynthInfo[]
}

/**
 * Pre-synthesize every paragraph in a book sequentially, storing results in
 * the audio cache. Cache hits are free (no Piper inference).
 *
 * Returns per-paragraph cache keys and durations for downstream concat+encode
 * (mobile Path A) or streaming (future M9.1).
 *
 * The caller is responsible for passing **cleaned** chapters — the cache key
 * is derived from the paragraph text, so it must match what the reader will
 * request.
 */
export async function preSynthesizeBook(opts: PreSynthOptions): Promise<PreSynthResult> {
  const { bookId, chapters, voiceId, engine, onProgress, onVoiceDownload, signal } = opts

  const paragraphs: string[] = []
  for (const ch of chapters) {
    for (const p of ch.paragraphs) {
      if (p.trim()) paragraphs.push(p)
    }
  }
  const total = paragraphs.length

  if (!(await engine.isStored(voiceId))) {
    await engine.download(voiceId, onVoiceDownload)
  }

  let done = 0
  let synthesized = 0
  let cached = 0
  const info: ParagraphPreSynthInfo[] = []

  for (const text of paragraphs) {
    if (signal?.aborted) {
      return { total, synthesized, cached, cancelled: true, paragraphs: info }
    }

    const result = await engine.synthesize({ text, voiceId, bookId })
    if (result.synthMs === 0) cached++
    else synthesized++
    done++
    onProgress?.(done, total)

    const wav = await result.audio.arrayBuffer()
    const durationSeconds = parseWavDuration(wav)
    const cacheKey = await audioCacheKey(voiceId, text)

    info.push({ cacheKey, durationSeconds })
  }

  return { total, synthesized, cached, cancelled: false, paragraphs: info }
}
