import type { Book, BookId } from '../types'
import { BookCover } from './BookCover'

const DAY = 86_400_000

/** Render an `updatedAt` timestamp as a short relative label. Pure given `now`. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const days = Math.floor(diff / DAY)
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks === 1) return '1 week ago'
  if (weeks < 5) return `${weeks} weeks ago`
  const months = Math.floor(days / 30)
  return months <= 1 ? '1 month ago' : `${months} months ago`
}

interface BookCardProps {
  book: Book
  onOpen: (id: BookId) => void
  onDelete: (id: BookId) => void
}

export function BookCard({ book, onOpen, onDelete }: BookCardProps) {
  const pct = Math.round((book.progressFraction ?? 0) * 100)
  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={() => onOpen(book.id)}
        className="group text-left"
        aria-label={`Open ${book.title}`}
      >
        <BookCover title={book.title} className="transition-transform group-hover:scale-[1.02]" />
        <div className="tt-line-clamp-2 mt-2 line-clamp-2 font-medium text-fg">{book.title}</div>
      </button>
      <div className="mt-1 flex items-center justify-between text-xs text-muted">
        <span className="uppercase tracking-wide">{book.format}</span>
        <span>{formatRelativeTime(book.updatedAt)}</span>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-elevated"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}% read`}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <button
        type="button"
        onClick={() => onDelete(book.id)}
        className="mt-2 self-start text-xs text-muted transition-colors hover:text-red-400"
        aria-label={`Delete ${book.title}`}
      >
        Delete
      </button>
    </li>
  )
}
