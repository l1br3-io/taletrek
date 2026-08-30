import { useEffect, useMemo, useState } from 'react'
import { useDatasource } from '../../../context/datasource'
import { useSettings } from '../../../context/settings'
import { resolveMobileEngine } from '../../../lib/playback/engines'
import type { TtsEngine } from '../../../lib/tts/types'
import type { BookId, Chapter, VoiceId } from '../../../types'
import type { UseParagraphPlayerResult } from './types'
import { useDesktopPlayer } from './useDesktopPlayer'
import { usePreloadedPlayer } from './usePreloadedPlayer'
import { useWebAudioPlayer } from './useWebAudioPlayer'

export interface UsePlayerArgs {
  chapters: Chapter[]
  voiceId: VoiceId
  playbackRate: number
  /**
   * Engine slot (the playback seam). Post-pivot (ADR-0015) the reader passes
   * the unavailable stub — cache misses surface an error instead of
   * synthesizing. The seam stays so a future engine can return.
   */
  engine: TtsEngine
  initialIndex?: number
  bookId?: BookId
}

export function usePlayer(
  args: UsePlayerArgs,
  opts: { isMobile: boolean },
): UseParagraphPlayerResult {
  const { library } = useDatasource()
  const desktop = useDesktopPlayer(args)
  const preloaded = usePreloadedPlayer(args)
  const webAudio = useWebAudioPlayer(args)

  const { settings } = useSettings()
  // Engine capabilities never change during a session (cached in engines.ts),
  // and the setting rarely does — memoize so re-renders don't re-run the
  // (cached) resolution.
  const engineId = useMemo(
    () => (opts.isMobile ? resolveMobileEngine(settings.playbackEngine) : null),
    [opts.isMobile, settings.playbackEngine],
  )

  const [hasBookAudio, setHasBookAudio] = useState<boolean | null>(null)
  useEffect(() => {
    // The FFmpeg engine plays the whole-book m4a from IDB; the Web Audio engine
    // reads paragraph audio from the cache and ignores bookAudio entirely.
    if (!opts.isMobile || engineId !== 'ffmpeg' || !args.bookId) {
      setHasBookAudio(null)
      return
    }
    let cancelled = false
    library
      .getBookAudio(args.bookId)
      .then((audio) => {
        if (!cancelled) setHasBookAudio(audio !== undefined)
      })
      .catch(() => {
        if (!cancelled) setHasBookAudio(false)
      })
    return () => {
      cancelled = true
    }
  }, [args.bookId, opts.isMobile, engineId, library])

  if (!opts.isMobile) return desktop
  if (engineId === 'web-audio') return webAudio
  // FFmpeg engine: books without a whole-book m4a (the common case for
  // imported bundles — per-paragraph audio) fall back to the desktop
  // per-paragraph player, which reads each paragraph from the cache.
  if (hasBookAudio === false) return desktop
  return preloaded
}
