import { useEffect, useMemo, useState } from 'react'
import { useSettings } from '../../../context/settings'
import { localDatasource } from '../../../lib/datasource'
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
  /**
   * Mobile-only (FFmpeg engine): when true, the m4a is either being
   * synthesized/encoded or the upload is otherwise in-progress. Falling back
   * to the desktop per-paragraph engine here would let the user click any
   * paragraph and play it on-demand — exactly the lock-broken trap ADR-0010
   * §5 says to avoid. Pin to the preloaded player (whose seekToParagraph
   * no-ops when no `<video>` exists) so the lockdown holds at the engine
   * level, not just at the PlayerBar button layer.
   */
  synthLockdown?: boolean
  /**
   * Re-triggers the `getBookAudio` probe when bumped. Without this, an
   * FFmpeg job that completes while the reader is mounted leaves the player
   * stuck on the preloaded fallback (no m4a found at first probe → state
   * never re-fires) until a route change.
   */
  bookAudioRefreshToken?: number
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps — re-probe m4a after upload completes. The token isn't read inside; it's a refresh signal (mirrors `cacheRefreshToken` in ReaderPane).
  useEffect(() => {
    // The FFmpeg engine plays the whole-book m4a from IDB; the Web Audio engine
    // reads paragraph WAVs from the cache and ignores bookAudio entirely.
    if (!opts.isMobile || engineId !== 'ffmpeg' || !args.bookId) {
      setHasBookAudio(null)
      return
    }
    let cancelled = false
    localDatasource
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
  }, [args.bookId, opts.isMobile, engineId, args.bookAudioRefreshToken])

  if (!opts.isMobile) return desktop
  if (engineId === 'web-audio') return webAudio
  // FFmpeg engine:
  //  - During an active synth/encode job for this book, pin to the preloaded
  //    player. The preloaded player's `seekToParagraph` no-ops until the
  //    `<video>` element exists (created on Play, which PlayerBar's
  //    `synthLockdown` disables), so paragraph clicks in ReaderView stay
  //    inert. This closes the leak where the desktop per-paragraph fallback
  //    synthesized + played any clicked paragraph mid-upload (issue #4).
  //  - Outside lockdown: huge-book uploads may intentionally skip the
  //    whole-book encode (gotcha #20). In that case fall back to the desktop
  //    per-paragraph engine — there's no m4a to preload against.
  if (args.synthLockdown) return preloaded
  if (hasBookAudio === false) return desktop
  return preloaded
}
