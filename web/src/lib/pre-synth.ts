import type { BookId, Chapter, VoiceId } from '../types'
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

export interface PreSynthResult {
  total: number
  synthesized: number
  cached: number
  cancelled: boolean
}

/**
 * Pre-synthesize every paragraph in a book sequentially, storing results in
 * the audio cache. Cache hits are free (no Piper inference). Designed to run
 * on the upload screen so the first reading session has zero synthesis latency.
 *
 * The caller is responsible for passing **cleaned** chapters — the cache key
 * is derived from the paragraph text, so it must match what the reader will
 * request via `useParagraphPlayer`.
 *
 * Cancellation is cooperative: pass an `AbortSignal` and it is checked between
 * paragraphs. The function returns partial results on cancel.
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

  for (const text of paragraphs) {
    if (signal?.aborted) {
      return { total, synthesized, cached, cancelled: true }
    }

    const result = await engine.synthesize({ text, voiceId, bookId })
    if (result.synthMs === 0) cached++
    else synthesized++
    done++
    onProgress?.(done, total)
  }

  return { total, synthesized, cached, cancelled: false }
}
