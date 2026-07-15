import type { TtsEngine } from '../../../lib/tts/types'
import type { BookId, Chapter, VoiceId } from '../../../types'
import type { UseParagraphPlayerResult } from './types'
import { useDesktopPlayer } from './useDesktopPlayer'
import { usePreloadedPlayer } from './usePreloadedPlayer'
import { useStreamingPlayer } from './useStreamingPlayer'

export interface UsePlayerArgs {
  chapters: Chapter[]
  voiceId: VoiceId
  playbackRate: number
  engine: TtsEngine
  initialIndex?: number
  bookId?: BookId
  /** Desktop-only: true while background synth is running for this book. */
  backgroundActive?: boolean
  /** Desktop-only: paragraph ids already synth'd by the background job. */
  backgroundBufferedIds?: Set<string>
  /** Desktop-only: paragraph ids known to be cached in persistent audioCache. */
  cachedParagraphIds?: Set<string>
  /** Desktop-only: fired after each successful synthesis. */
  onParagraphSynthesized?: (paragraphId: string) => void
}

export function usePlayer(
  args: UsePlayerArgs,
  opts: { isMobile: boolean },
): UseParagraphPlayerResult {
  const desktop = useDesktopPlayer(args)
  const preloaded = usePreloadedPlayer(args)
  useStreamingPlayer(args)

  if (!opts.isMobile) return desktop
  return preloaded
}
