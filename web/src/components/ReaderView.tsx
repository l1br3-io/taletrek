import type { KeyboardEvent, RefObject } from 'react'
import type { Book, Chapter } from '../types'

interface ReaderViewProps {
  book: Book
  chapters: Chapter[]
  /** Paragraph id currently being spoken, or null. */
  currentParagraphId?: string | null
  /** Tap a paragraph to seek playback there. */
  onSeekParagraph?: (id: string) => void
  /**
   * Attached to the active `<p>` (the one matching `currentParagraphId`) so the
   * container can scroll it into view. Re-attached as the active paragraph moves.
   */
  activeParagraphRef?: RefObject<HTMLParagraphElement | null>
  /** Paragraph id to briefly pulse-highlight (e.g. after Outline navigation). */
  pulseParagraphId?: string | null
  /** Invoked when the pulse animation finishes. */
  onPulseEnd?: () => void
}

interface ParagraphItem {
  id: string
  text: string
}

function paragraphItems(paragraphs: readonly string[], chapterId: string): ParagraphItem[] {
  return paragraphs.map((text, index) => ({ id: `${chapterId}:${index}`, text }))
}

export function ReaderView({
  book,
  chapters,
  currentParagraphId,
  onSeekParagraph,
  activeParagraphRef,
  pulseParagraphId,
  onPulseEnd,
}: ReaderViewProps) {
  const multi = chapters.length > 1
  return (
    <article className="space-y-6 sm:space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold sm:text-3xl">{book.title}</h1>
        <p className="text-sm uppercase tracking-wide text-muted">
          {book.format} · {chapters.length} chapter{multi ? 's' : ''}
        </p>
      </header>
      {chapters.map((chapter) => (
        <section key={chapter.id} className="space-y-4">
          {multi && <h2 className="text-lg font-semibold text-fg">{chapter.title}</h2>}
          <div className="tt-reader-text space-y-4 text-fg">
            {paragraphItems(chapter.paragraphs, chapter.id).map((item) => {
              const active = item.id === currentParagraphId
              const seekable = !!onSeekParagraph
              const pulsing = item.id === pulseParagraphId
              const seekProps = seekable
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onClick: () => onSeekParagraph?.(item.id),
                    onKeyDown: (e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSeekParagraph?.(item.id)
                      }
                    },
                  }
                : {}
              return (
                <p
                  key={item.id}
                  ref={active && activeParagraphRef ? activeParagraphRef : undefined}
                  className={[
                    active
                      ? 'rounded bg-accent-soft p-2 -mx-2 ring-1 ring-accent'
                      : seekable
                        ? 'cursor-pointer'
                        : '',
                    pulsing ? 'tt-nav-pulse' : '',
                  ]
                    .join(' ')
                    .trim()}
                  onAnimationEnd={pulsing ? onPulseEnd : undefined}
                  {...seekProps}
                >
                  {item.text}
                </p>
              )
            })}
          </div>
        </section>
      ))}
    </article>
  )
}
