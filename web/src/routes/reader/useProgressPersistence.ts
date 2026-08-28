import { useEffect, useRef } from 'react'
import { useDatasource } from '../../context/datasource'
import type { BookId, BookPosition } from '../../types'
import type { ParagraphRef } from './players/types'

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
  const { library } = useDatasource()
  const latestRef = useRef<{ position: BookPosition; fraction: number } | null>(null)

  useEffect(() => {
    if (currentIndex === null || currentParagraph === null) return
    const fraction = totalParagraphs > 0 ? (currentIndex + 1) / totalParagraphs : 0
    latestRef.current = { position: toPosition(currentParagraph), fraction }
    const handle = setTimeout(() => {
      if (latestRef.current) {
        void library.updateBookProgress(
          bookId,
          latestRef.current.position,
          latestRef.current.fraction,
        )
      }
    }, 2000)
    return () => clearTimeout(handle)
  }, [currentIndex, currentParagraph, bookId, totalParagraphs, library])

  useEffect(() => {
    return () => {
      if (latestRef.current) {
        void library.updateBookProgress(
          bookId,
          latestRef.current.position,
          latestRef.current.fraction,
        )
      }
    }
  }, [bookId, library])
}
