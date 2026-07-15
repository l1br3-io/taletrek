import type { TtsEngine } from '../../../lib/tts/types'
import type { BookId, Chapter, VoiceId } from '../../../types'
import type { UseParagraphPlayerResult } from './types'

export interface UseStreamingPlayerArgs {
  chapters: Chapter[]
  voiceId: VoiceId
  playbackRate: number
  engine?: TtsEngine
  initialIndex?: number
  bookId?: BookId
}

/**
 * Future: WebCodecs AudioEncoder + mp4-muxer + MSE streaming playback.
 * Requires iOS Safari 26+ (feature-detect `AudioEncoder`).
 * Not yet implemented — returns idle placeholder.
 */
export function useStreamingPlayer(_args: UseStreamingPlayerArgs): UseParagraphPlayerResult {
  return {
    status: { type: 'idle' as const },
    currentParagraphId: null,
    currentParagraph: null,
    currentIndex: null,
    bufferedAhead: 0,
    play: () => {},
    pause: () => {},
    stop: () => {},
    next: () => {},
    prev: () => {},
    nextChapter: () => {},
    prevChapter: () => {},
    seekToParagraph: () => {},
    navigateToParagraph: () => {},
    seekBy: () => {},
    seekTo: () => {},
    getAudioPosition: () => ({ currentTime: 0, duration: 0 }),
  }
}
