import type { KeyboardEvent } from 'react'
import type { Book, Chapter } from '../types'

interface ReaderViewProps {
  book: Book
  chapters: Chapter[]
  /** Paragraph id currently being spoken, or null. */
  currentParagraphId?: string | null
  /** Tap a paragraph to seek playback there. */
  onSeekParagraph?: (id: string) => void
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
}: ReaderViewProps) {
  const multi = chapters.length > 1
  return (
    <article className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{book.title}</h1>
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
                  className={
                    active
                      ? 'rounded bg-accent-soft p-2 -mx-2 ring-1 ring-accent'
                      : seekable
                        ? 'cursor-pointer'
                        : ''
                  }
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
