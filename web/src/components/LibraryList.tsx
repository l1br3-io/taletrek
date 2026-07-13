import type { Book, BookId } from '../types'
import { BookCard } from './BookCard'

interface LibraryListProps {
  books: readonly Book[]
  onOpen: (id: BookId) => void
  onDelete: (id: BookId) => void
  /** When provided (AI enabled), shows a "Reprocess" action on each card. */
  onReprocess?: (id: BookId) => void
  /** When provided (AI enabled), shows a "Hints" action on each card. */
  onPronunciation?: (id: BookId) => void
  /** When provided, shows an "Outline" action on each card (hidden for EPUB). */
  onOutline?: (id: BookId) => void
  /** When provided (synth mode enabled), shows a "Synthesize" action on each card. */
  onResynthesize?: (id: BookId) => void
}

export function LibraryList({
  books,
  onOpen,
  onDelete,
  onReprocess,
  onPronunciation,
  onOutline,
  onResynthesize,
}: LibraryListProps) {
  if (books.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface p-10 text-center">
        <p className="text-muted">Your library is empty. Upload a book to start reading.</p>
      </div>
    )
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
      {books.map((book) => (
        <BookCard
          key={book.id}
          book={book}
          onOpen={onOpen}
          onDelete={onDelete}
          onReprocess={onReprocess}
          onPronunciation={onPronunciation}
          onOutline={onOutline}
          onResynthesize={onResynthesize}
        />
      ))}
    </ul>
  )
}
