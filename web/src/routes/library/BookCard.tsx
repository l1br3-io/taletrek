import { AudioLines, List, MoreVertical, Pencil, SpellCheck, Trash2 } from 'lucide-react'
import { Menu } from '../../components/Menu'
import type { Book, BookId } from '../../types'

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
  /** When provided (AI enabled), shows an "Edit" action on the card. */
  onEdit?: (id: BookId) => void
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
  onEdit,
  onPronunciation,
  onOutline,
  onResynthesize,
}: BookCardProps) {
  const pct = Math.round((book.progressFraction ?? 0) * 100)
  const showOutline = onOutline && book.format !== 'epub'

  const actionsMenu = (
    <Menu
      placement="bottom-end"
      panelClassName="w-48 border border-line bg-surface p-1 shadow-xl"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={`More actions for ${book.title}`}
          className="inline-flex items-center gap-1 px-1.5 py-1 text-muted transition-colors hover:text-fg"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      )}
    >
      {(close) => (
        <>
          {onResynthesize && (
            <button
              type="button"
              onClick={() => {
                onResynthesize(book.id)
                close()
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-sm transition-colors hover:bg-elevated"
              aria-label={`Synthesize ${book.title}`}
            >
              <AudioLines className="h-4 w-4" /> Synthesize
            </button>
          )}
          {showOutline && (
            <button
              type="button"
              onClick={() => {
                onOutline?.(book.id)
                close()
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-sm transition-colors hover:bg-elevated"
              aria-label={`Generate outline for ${book.title}`}
            >
              <List className="h-4 w-4" /> Outline
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={() => {
                onEdit(book.id)
                close()
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-sm transition-colors hover:bg-elevated"
              aria-label={`Edit ${book.title}`}
            >
              <Pencil className="h-4 w-4" /> Edit
            </button>
          )}
          {onPronunciation && (
            <button
              type="button"
              onClick={() => {
                onPronunciation(book.id)
                close()
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-sm transition-colors hover:bg-elevated"
              aria-label={`Review pronunciation for ${book.title}`}
            >
              <SpellCheck className="h-4 w-4" /> Hints
            </button>
          )}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            onClick={() => {
              onDelete(book.id)
              close()
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10"
            aria-label={`Delete ${book.title}`}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </>
      )}
    </Menu>
  )

  return (
    <li className="group border-b border-line last:border-b-0">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => onOpen(book.id)}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left"
          aria-label={`Open ${book.title}`}
        >
          <span
            className="text-accent opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          >
            ❯
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-fg">
              {book.title}
              {book.uploading && (
                <span className="ml-2 inline-flex items-center rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
                  Uploading…
                </span>
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <span>{book.format}</span>
              <span aria-hidden>·</span>
              <span>{pct}%</span>
              <span aria-hidden>·</span>
              <span>{formatRelativeTime(book.updatedAt)}</span>
            </span>
          </span>
        </button>
        <div className="flex items-center pr-1">{actionsMenu}</div>
      </div>
      <div
        className="h-px w-full bg-line"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}% read`}
      >
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </li>
  )
}
