import type { Chapter } from '../../../types'

export const DEFAULT_LOOKAHEAD = 8

export interface ParagraphRef {
  id: string
  chapterId: Chapter['id']
  chapterIndex: number
  paragraphIndex: number
  text: string
}

export type PlaybackStatus =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'buffering' }
  | { type: 'playing'; paragraphId: string }
  | { type: 'paused'; paragraphId: string }
  | { type: 'ended' }
  | { type: 'error'; message: string }

export interface UseParagraphPlayerResult {
  status: PlaybackStatus
  currentParagraphId: string | null
  currentParagraph: ParagraphRef | null
  currentIndex: number | null
  bufferedAhead: number
  play: () => void
  pause: () => void
  stop: () => void
  next: () => void
  prev: () => void
  nextChapter: () => void
  prevChapter: () => void
  seekToParagraph: (id: string) => void
  navigateToParagraph: (id: string) => void
  seekBy: (deltaSeconds: number) => void
  seekTo: (seconds: number) => void
  getAudioPosition: () => { currentTime: number; duration: number }
}

export function flattenParagraphs(chapters: readonly Chapter[]): ParagraphRef[] {
  return chapters.flatMap((chapter) =>
    chapter.paragraphs.map((text, paragraphIndex) => ({
      id: `${chapter.id}:${paragraphIndex}`,
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      paragraphIndex,
      text,
    })),
  )
}
