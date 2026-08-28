import { useEffect, useState } from 'react'
import { useDatasource } from '../../context/datasource'
import type { BookId, Chapter, VoiceId } from '../../types'

/**
 * Probe the audio cache for which paragraphs of a book are pre-rendered.
 * Returns a set of positional IDs (`${chapterId}:${index}`) suitable for
 * passing to `ReaderView` / `Outline` as `bufferedParagraphIds`.
 *
 * Pass **cleaned** chapters so cache keys match what the engine produces.
 *
 * @param refreshToken  Bump to force a re-probe (e.g. after a synth job finishes).
 */
export function useCachedParagraphs(
  bookId: BookId,
  voiceId: VoiceId,
  chapters: Chapter[],
  refreshToken: number,
): Set<string> {
  const { library } = useDatasource()
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set())

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is a caller-controlled prop that changes when a synth job finishes
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ids = await library.getCachedParagraphIds(bookId, voiceId, chapters)
        if (!cancelled) setCachedIds(ids)
      } catch {
        if (!cancelled) setCachedIds(new Set())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, voiceId, chapters, refreshToken, library])

  return cachedIds
}
