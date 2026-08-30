import type { KeyboardEvent, RefObject } from 'react'
import type { Book, Chapter } from '../../types'

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
  /** Paragraph id to mark as the navigation target (e.g. after Outline nav). */
  pulseParagraphId?: string | null
  /** Invoked when the target animation finishes. */
  onPulseEnd?: () => void
  /**
   * Set of positional paragraph IDs (`${chapterId}:${index}`) that are cached.
   * A subtle faded dot is rendered before each cached paragraph; uncached
   * paragraphs show nothing.
   */
  bufferedParagraphIds?: Set<string>
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
  bufferedParagraphIds,
}: ReaderViewProps) {
  const multi = chapters.length > 1
  return (
    <article className="space-y-6 sm:space-y-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold sm:text-3xl">
          <span className="text-accent" aria-hidden>
            ❯
          </span>
          {book.title}
        </h1>
        <p className="text-xs text-muted">
          {book.format} · {chapters.length} chapter{multi ? 's' : ''}
        </p>
      </header>
      {chapters.map((chapter) => {
        const items = paragraphItems(chapter.paragraphs, chapter.id)
        return (
          <section key={chapter.id} className="space-y-4">
            {multi && <h2 className="text-base font-semibold text-fg">{chapter.title}</h2>}
            <div className="tt-reader-text space-y-4 text-fg">
              {items.map((item) => {
                const active = item.id === currentParagraphId
                const seekable = !!onSeekParagraph
                const pulsing = item.id === pulseParagraphId
                const isBuffered = bufferedParagraphIds?.has(item.id) ?? false
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
                        ? 'bg-accent-soft p-2 -mx-2 ring-1 ring-accent'
                        : seekable
                          ? 'cursor-pointer'
                          : '',
                      pulsing ? 'tt-nav-target' : '',
                    ]
                      .join(' ')
                      .trim()}
                    onAnimationEnd={pulsing ? onPulseEnd : undefined}
                    {...seekProps}
                  >
                    {isBuffered && (
                      <span
                        className="mr-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-accent/30 align-middle"
                        aria-hidden
                      />
                    )}
                    {item.text}
                  </p>
                )
              })}
            </div>
          </section>
        )
      })}
    </article>
  )
}
