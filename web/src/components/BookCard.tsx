import { AudioLines, List, RefreshCw, SpellCheck, Trash2 } from 'lucide-react'
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
  /** When provided (AI enabled), shows a "Reprocess" action on the card. */
  onReprocess?: (id: BookId) => void
  /** When provided (AI enabled), shows a "Hints" action on the card. */
  onPronunciation?: (id: BookId) => void
  /** When provided, shows an "Outline" action (hidden for EPUB — already has TOC). */
  onOutline?: (id: BookId) => void
  /** When provided (synth mode enabled), shows a "Synthesize" action on the card. */
  onResynthesize?: (id: BookId) => void
}

export function BookCard({
  book,
  onOpen,
  onDelete,
  onReprocess,
  onPronunciation,
  onOutline,
  onResynthesize,
}: BookCardProps) {
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
      <div className="mt-2 flex flex-wrap gap-3">
        {onOutline && book.format !== 'epub' && (
          <button
            type="button"
            onClick={() => onOutline(book.id)}
            className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-accent"
            aria-label={`Generate outline for ${book.title}`}
          >
            <List className="h-3.5 w-3.5" /> Outline
          </button>
        )}
        {onReprocess && (
          <button
            type="button"
            onClick={() => onReprocess(book.id)}
            className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-accent"
            aria-label={`Reprocess ${book.title}`}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Reprocess
          </button>
        )}
        {onResynthesize && (
          <button
            type="button"
            onClick={() => onResynthesize(book.id)}
            className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-accent"
            aria-label={`Re-synthesize ${book.title}`}
          >
            <AudioLines className="h-3.5 w-3.5" /> Synthesize
          </button>
        )}
        {onPronunciation && (
          <button
            type="button"
            onClick={() => onPronunciation(book.id)}
            className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-accent"
            aria-label={`Review pronunciation for ${book.title}`}
          >
            <SpellCheck className="h-3.5 w-3.5" /> Hints
          </button>
        )}
        <button
          type="button"
          onClick={() => onDelete(book.id)}
          className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-red-400"
          aria-label={`Delete ${book.title}`}
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
    </li>
  )
}
