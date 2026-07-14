import { useEffect, useRef } from 'react'
import { updateBookProgress } from '../../lib/db'
import type { BookId, BookPosition } from '../../types'
import type { ParagraphRef } from './useParagraphPlayer'

function toPosition(p: ParagraphRef): BookPosition {
  return { chapterIndex: p.chapterIndex, paragraphIndex: p.paragraphIndex }
}

interface UseProgressPersistenceArgs {
  bookId: BookId
  currentIndex: number | null
  currentParagraph: ParagraphRef | null
  totalParagraphs: number
}

/**
 * Debounced progress persistence: write at most once per ~2s of movement, and
 * flush the final position on unmount. `latestRef` holds the most recent pos.
 */
export function useProgressPersistence({
  bookId,
  currentIndex,
  currentParagraph,
  totalParagraphs,
}: UseProgressPersistenceArgs) {
  const latestRef = useRef<{ position: BookPosition; fraction: number } | null>(null)

  useEffect(() => {
    if (currentIndex === null || currentParagraph === null) return
    const fraction = totalParagraphs > 0 ? (currentIndex + 1) / totalParagraphs : 0
    latestRef.current = { position: toPosition(currentParagraph), fraction }
    const handle = setTimeout(() => {
      if (latestRef.current) {
        void updateBookProgress(bookId, latestRef.current.position, latestRef.current.fraction)
      }
    }, 2000)
    return () => clearTimeout(handle)
  }, [currentIndex, currentParagraph, bookId, totalParagraphs])

  useEffect(() => {
    return () => {
      if (latestRef.current) {
        void updateBookProgress(bookId, latestRef.current.position, latestRef.current.fraction)
      }
    }
  }, [bookId])
}
