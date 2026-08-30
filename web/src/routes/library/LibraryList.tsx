import type { Book, BookId } from '../../types'
import { BookCard } from './BookCard'

interface LibraryListProps {
  books: readonly Book[]
  onOpen: (id: BookId) => void
  onDelete: (id: BookId) => void
  /** When provided, shows an "Export bundle" action on each card. */
  onExportBundle?: (id: BookId) => void
  /** When provided, shows a "Rename" action on each card. */
  onRename?: (id: BookId) => void
}

export function LibraryList({
  books,
  onOpen,
  onDelete,
  onExportBundle,
  onRename,
}: LibraryListProps) {
  if (books.length === 0) {
    return (
      <div className="border border-dashed border-line bg-surface p-10 text-center">
        <p className="text-muted">
          <span className="text-accent" aria-hidden>
            ❯
          </span>{' '}
          Your library is empty. Import a `.taletrek` bundle to start listening.
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
          onExportBundle={onExportBundle}
          onRename={onRename}
        />
      ))}
    </ul>
  )
}
