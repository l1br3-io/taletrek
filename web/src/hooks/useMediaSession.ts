import { useEffect, useRef } from 'react'
import {
  clearMediaSession,
  setMediaMetadata,
  setMediaPlaybackState,
  setMediaPositionState,
  setMediaSessionHandlers,
} from '../lib/media-session'
import type { Chapter } from '../types'
import type { PlaybackStatus } from './useParagraphPlayer'

const ARTWORK_URL = '/icons/pwa-512.png'
const SEEK_STEP_SECONDS = 15

/** The slice of the player the Media Session wiring drives. */
export interface MediaSessionPlayer {
  status: PlaybackStatus
  currentParagraphId: string | null
  play: () => void
  pause: () => void
  nextChapter: () => void
  prevChapter: () => void
  seekBy: (deltaSeconds: number) => void
  seekTo: (seconds: number) => void
  getAudioPosition: () => { currentTime: number; duration: number }
}

export interface UseMediaSessionArgs {
  player: MediaSessionPlayer
  bookTitle: string
  chapters: Chapter[]
  playbackRate: number
}

function chapterTitleFor(paragraphId: string | null, chapters: Chapter[]): string {
  if (!paragraphId) return chapters[0]?.title ?? ''
  const match = chapters.find((c) => paragraphId.startsWith(`${c.id}:`))
  return match?.title ?? chapters[0]?.title ?? ''
}

/**
 * Wires the pre-rendering player to the OS Media Session: registers lock-screen
 * action handlers once on mount (delegating to the latest player via a ref),
 * updates metadata when the book or current chapter changes, and reflects
 * playback + position state on transitions. Cleans up on unmount.
 */
export function useMediaSession({
  player,
  bookTitle,
  chapters,
  playbackRate,
}: UseMediaSessionArgs) {
  // Mirror the player into a ref so handlers registered once always call latest.
  const playerRef = useRef(player)
  playerRef.current = player

  const currentChapterTitle = chapterTitleFor(player.currentParagraphId, chapters)

  // Register action handlers once on mount; cleanup on unmount.
  useEffect(() => {
    const cleanup = setMediaSessionHandlers({
      play: () => playerRef.current.play(),
      pause: () => playerRef.current.pause(),
      seekbackward: () => playerRef.current.seekBy(-SEEK_STEP_SECONDS),
      seekforward: () => playerRef.current.seekBy(SEEK_STEP_SECONDS),
      seekto: (t) => {
        if (t != null) playerRef.current.seekTo(t)
      },
      nexttrack: () => playerRef.current.nextChapter(),
      previoustrack: () => playerRef.current.prevChapter(),
    })
    return () => {
      cleanup()
      clearMediaSession()
    }
  }, [])

  // Update metadata when the book or current chapter changes.
  useEffect(() => {
    setMediaMetadata({
      title: bookTitle,
      artist: 'TaleTrek',
      album: currentChapterTitle,
      artworkUrl: ARTWORK_URL,
    })
  }, [bookTitle, currentChapterTitle])

  // Reflect playback + position state on status transitions.
  useEffect(() => {
    switch (player.status.type) {
      case 'playing': {
        setMediaPlaybackState('playing')
        const { duration, currentTime } = playerRef.current.getAudioPosition()
        setMediaPositionState(duration || 1, currentTime || 0, playbackRate)
        break
      }
      case 'paused':
        setMediaPlaybackState('paused')
        break
      case 'idle':
      case 'ended':
      case 'error':
        setMediaPlaybackState('none')
        break
      case 'loading':
        break
    }
  }, [player.status, playbackRate])
}
