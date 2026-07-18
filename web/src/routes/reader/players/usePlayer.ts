import { useEffect, useMemo, useState } from 'react'
import { useSettings } from '../../../context/settings'
import { getBookAudio } from '../../../lib/book-audio'
import { resolveMobileEngine } from '../../../lib/playback/engines'
import type { TtsEngine } from '../../../lib/tts/types'
import type { BookId, Chapter, VoiceId } from '../../../types'
import type { UseParagraphPlayerResult } from './types'
import { useDesktopPlayer } from './useDesktopPlayer'
import { usePreloadedPlayer } from './usePreloadedPlayer'
import { useStreamingPlayer } from './useStreamingPlayer'
import { useWebAudioPlayer } from './useWebAudioPlayer'

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
  const webAudio = useWebAudioPlayer(args)
  useStreamingPlayer(args)

  const { settings } = useSettings()
  // Engine capabilities never change during a session (cached in engines.ts),
  // and the setting rarely does — memoize so the per-paragraph synth re-renders
  // don't even re-run the (cached) resolution.
  const engineId = useMemo(
    () => (opts.isMobile ? resolveMobileEngine(settings.playbackEngine) : null),
    [opts.isMobile, settings.playbackEngine],
  )

  const [hasBookAudio, setHasBookAudio] = useState<boolean | null>(null)
  useEffect(() => {
    // The FFmpeg engine plays the whole-book m4a from IDB; the Web Audio engine
    // reads paragraph WAVs from the cache and ignores bookAudio entirely.
    if (!opts.isMobile || engineId !== 'ffmpeg' || !args.bookId) {
      setHasBookAudio(null)
      return
    }
    let cancelled = false
    getBookAudio(args.bookId)
      .then((audio) => {
        if (!cancelled) setHasBookAudio(audio !== undefined)
      })
      .catch(() => {
        if (!cancelled) setHasBookAudio(false)
      })
    return () => {
      cancelled = true
    }
  }, [args.bookId, opts.isMobile, engineId])

  if (!opts.isMobile) return desktop
  if (engineId === 'web-audio') return webAudio
  // FFmpeg engine: huge-book uploads may intentionally skip the whole-book
  // encode — in that case fall back to the desktop per-paragraph engine.
  if (hasBookAudio === false) return desktop
  return preloaded
}
