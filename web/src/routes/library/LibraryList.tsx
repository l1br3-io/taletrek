import type { Book, BookId } from '../../types'
import { BookCard } from './BookCard'

interface LibraryListProps {
  books: readonly Book[]
  onOpen: (id: BookId) => void
  onDelete: (id: BookId) => void
  /** When provided (AI enabled), shows an "Edit" action on each card. */
  onEdit?: (id: BookId) => void
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
  onEdit,
  onPronunciation,
  onOutline,
  onResynthesize,
}: LibraryListProps) {
  if (books.length === 0) {
    return (
      <div className="border border-dashed border-line bg-surface p-10 text-center">
        <p className="text-muted">
          <span className="text-accent" aria-hidden>
            ❯
          </span>{' '}
          Your library is empty. Upload a book to start reading.
        </p>
      </div>
    )
  }

  return (
    <ul className="border border-line bg-surface px-4">
      {books.map((book) => (
        <BookCard
          key={book.id}
          book={book}
          onOpen={onOpen}
          onDelete={onDelete}
          onEdit={onEdit}
          onPronunciation={onPronunciation}
          onOutline={onOutline}
          onResynthesize={onResynthesize}
        />
      ))}
    </ul>
  )
}
