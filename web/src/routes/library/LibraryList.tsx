import type { Book, BookId } from '../../types'
import type { AiUnusableReason } from './AiStatusChip'
import { BookCard, type SynthStatusChip } from './BookCard'

interface LibraryListProps {
  books: readonly Book[]
  onOpen: (id: BookId) => void
  onDelete: (id: BookId) => void
  /** When provided (AI enabled), shows a "Transform" action on each card. */
  onTransform?: (id: BookId) => void
  /** When provided (AI enabled), shows a "Hints" action on each card. */
  onPronunciation?: (id: BookId) => void
  /** When provided, shows an "Outline" action on each card (hidden for EPUB). */
  onOutline?: (id: BookId) => void
  /** When provided (synth mode enabled), shows a "Synthesize" action on each card. */
  onResynthesize?: (id: BookId) => void
  /** When provided, resumes a paused synthesis job for the book (ADR-0010 / M11). */
  onResume?: (id: BookId) => void
  /** When provided, shows an "Export bundle" action on each card. */
  onExportBundle?: (id: BookId) => void
  /** When provided, shows a "Rename" action on each card. */
  onRename?: (id: BookId) => void
  /**
   * Hosted-mode per-book synth status lookup (T16): when provided, each
   * card renders a status chip from the result. Omit in local mode.
   */
  synthStatusFor?: (id: BookId) => SynthStatusChip | undefined
  /**
   * When `false` AND AI menu items are shown, they render with an amber dot
   * indicator to signal "this feature is enabled but not usable right now"
   * (no provider, offline, etc.). Clicking still fires the handler — the
   * caller opens the explanatory sheet. `true` by default (no dot).
   */
  aiUsable?: boolean
  /**
   * When AI is enabled but not usable, the specific reason ("no-provider",
   * "misconfigured", "offline"). Forwarded to each `BookCard` so the
   * tooltip can name the blocker precisely. `null` when AI is fully usable
   * OR fully disabled.
   */
  aiUnusableReason?: AiUnusableReason | null
}

export function LibraryList({
  books,
  onOpen,
  onDelete,
  onTransform,
  onPronunciation,
  onOutline,
  onResynthesize,
  onResume,
  onExportBundle,
  onRename,
  synthStatusFor,
  aiUsable = true,
  aiUnusableReason = null,
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
          onTransform={onTransform}
          onPronunciation={onPronunciation}
          onOutline={onOutline}
          onResynthesize={onResynthesize}
          onResume={onResume}
          onExportBundle={onExportBundle}
          onRename={onRename}
          synthStatus={synthStatusFor?.(book.id)}
          aiUsable={aiUsable}
          aiUnusableReason={aiUnusableReason}
        />
      ))}
    </ul>
  )
}
