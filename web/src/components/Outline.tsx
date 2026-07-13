import { X } from 'lucide-react'
import { useEffect } from 'react'
import type { Chapter } from '../types'

interface OutlineProps {
  open: boolean
  chapters: Chapter[]
  /** Index of the chapter currently playing/reading, or null. */
  currentChapterIndex: number | null
  /** Select a chapter (and optionally a specific paragraph within it). */
  onSelect: (chapterIndex: number, paragraphIndex?: number) => void
  onClose: () => void
}

function chapterTitle(chapter: Chapter, fallbackIndex: number): string {
  const t = chapter.title.trim()
  return t.length > 0 ? t : `Chapter ${fallbackIndex + 1}`
}

export function Outline({ open, chapters, currentChapterIndex, onSelect, onClose }: OutlineProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const multi = chapters.length > 1

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Outline">
      <button
        type="button"
        aria-label="Close outline"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-sm flex-col border-l border-line bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            {multi ? 'Chapters' : 'Outline'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-line px-2 py-0.5 text-muted hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <nav className="flex-1 overflow-y-auto">
          <ul>
            {chapters.map((chapter, i) => {
              const active = currentChapterIndex === chapter.index
              return (
                <li key={chapter.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(chapter.index)
                      onClose()
                    }}
                    className={[
                      'block w-full border-b border-line/50 px-4 py-3 text-left text-sm transition-colors',
                      active
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'text-fg hover:bg-elevated',
                    ].join(' ')}
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className="mr-2 text-xs text-muted">{i + 1}.</span>
                    {chapterTitle(chapter, i)}
                  </button>
                  {chapter.headings && chapter.headings.length > 0 && (
                    <ul>
                      {chapter.headings.map((heading) => (
                        <li key={heading.paragraphIndex}>
                          <button
                            type="button"
                            onClick={() => {
                              onSelect(chapter.index, heading.paragraphIndex)
                              onClose()
                            }}
                            className="block w-full border-b border-line/30 px-4 py-2 pl-8 text-left text-xs text-muted transition-colors hover:bg-elevated hover:text-fg"
                          >
                            <span className="mr-1.5">·</span>
                            {heading.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </nav>
      </aside>
    </div>
  )
}
