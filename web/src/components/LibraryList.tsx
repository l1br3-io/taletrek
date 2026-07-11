import type { Book, BookId } from '../types'
import { BookCard } from './BookCard'

interface LibraryListProps {
  books: readonly Book[]
  onOpen: (id: BookId) => void
  onDelete: (id: BookId) => void
}

export function LibraryList({ books, onOpen, onDelete }: LibraryListProps) {
  if (books.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface p-10 text-center">
        <p className="text-muted">Your library is empty. Upload a book to start reading.</p>
      </div>
    )
  }
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {books.map((book) => (
        <BookCard key={book.id} book={book} onOpen={onOpen} onDelete={onDelete} />
      ))}
    </ul>
  )
}
