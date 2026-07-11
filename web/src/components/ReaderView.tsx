import type { Book, Chapter } from '../types'

interface ReaderViewProps {
  book: Book
  chapters: Chapter[]
}

interface ParagraphItem {
  key: string
  text: string
}

function paragraphItems(paragraphs: readonly string[], chapterId: string): ParagraphItem[] {
  const counts = new Map<string, number>()
  return paragraphs.map((text) => {
    const n = counts.get(text) ?? 0
    counts.set(text, n + 1)
    return { key: `${chapterId}#${n}#${text}`, text }
  })
}

export function ReaderView({ book, chapters }: ReaderViewProps) {
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
            {paragraphItems(chapter.paragraphs, chapter.id).map((item) => (
              <p key={item.key}>{item.text}</p>
            ))}
          </div>
        </section>
      ))}
    </article>
  )
}
