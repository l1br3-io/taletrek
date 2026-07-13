import { useMediaQuery } from '../hooks/useMediaQuery'
import type { Book, BookId } from '../types'
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
  // Single-column horizontal list on phones; multi-column cover grid from sm up.
  const isGrid = useMediaQuery('(min-width: 640px)')

  if (books.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface p-10 text-center">
        <p className="text-muted">Your library is empty. Upload a book to start reading.</p>
      </div>
    )
  }

  if (!isGrid) {
    return (
      <ul className="flex flex-col gap-3">
        {books.map((book) => (
          <BookCard
            key={book.id}
            book={book}
            variant="list"
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

  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {books.map((book) => (
        <BookCard
          key={book.id}
          book={book}
          variant="grid"
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
