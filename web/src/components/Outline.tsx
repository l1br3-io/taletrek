import { ChevronDown, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Chapter } from '../types'

interface OutlineProps {
  open: boolean
  chapters: Chapter[]
  /** Index of the chapter currently playing/reading, or null. */
  currentChapterIndex: number | null
  /** Select a chapter (and optionally a specific paragraph within it). */
  onSelect: (chapterIndex: number, paragraphIndex?: number) => void
  onClose: () => void
  /**
   * Set of cached paragraph IDs (`${chapterId}:${index}`). A subtle per-chapter
   * progress bar shows the fraction of paragraphs cached. Passed both during
   * active synth (live job progress) and during normal reading (persistent
   * cache probe).
   */
  bufferedParagraphIds?: Set<string>
}

function chapterTitle(chapter: Chapter, fallbackIndex: number): string {
  const t = chapter.title.trim()
  return t.length > 0 ? t : `Chapter ${fallbackIndex + 1}`
}

export function Outline({
  open,
  chapters,
  currentChapterIndex,
  onSelect,
  onClose,
  bufferedParagraphIds,
}: OutlineProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Accordion expand state. The current chapter auto-expands whenever the
  // outline opens or the cursor moves; the user's manual toggles are preserved.
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const s = new Set<number>()
    if (currentChapterIndex != null) s.add(currentChapterIndex)
    return s
  })
  useEffect(() => {
    if (!open || currentChapterIndex == null) return
    setExpanded((prev) =>
      prev.has(currentChapterIndex) ? prev : new Set(prev).add(currentChapterIndex),
    )
  }, [open, currentChapterIndex])

  const toggle = (index: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

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
              const total = chapter.paragraphs.length
              const headings = chapter.headings
              const hasHeadings = !!headings && headings.length > 0
              const isExpanded = expanded.has(chapter.index)
              const title = chapterTitle(chapter, i)
              const done = bufferedParagraphIds
                ? chapter.paragraphs.filter(
                    (_, pi) =>
                      bufferedParagraphIds.has(`${chapter.id}:${pi}`) ||
                      !chapter.paragraphs[pi]?.trim(),
                  ).length
                : 0
              const fraction = bufferedParagraphIds && total > 0 ? done / total : 0
              return (
                <li key={chapter.id}>
                  <div className="flex items-center border-b border-line/50">
                    {hasHeadings && (
                      <button
                        type="button"
                        onClick={() => toggle(chapter.index)}
                        aria-expanded={isExpanded}
                        aria-controls={`outline-headings-${chapter.id}`}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${title}`}
                        className="self-stretch px-2 text-muted transition-colors hover:text-fg"
                      >
                        <ChevronDown
                          className={`h-4 w-4 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                        />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(chapter.index)
                        onClose()
                      }}
                      className={[
                        'flex-1 px-4 py-3 text-left text-sm transition-colors',
                        active
                          ? 'bg-accent-soft font-medium text-accent'
                          : 'text-fg hover:bg-elevated',
                      ].join(' ')}
                      aria-current={active ? 'true' : undefined}
                    >
                      <span className="mr-2 text-xs text-muted">{i + 1}.</span>
                      {title}
                    </button>
                  </div>
                  {bufferedParagraphIds && total > 0 && (
                    <div className="h-0.5 w-full bg-accent/10">
                      <div
                        className="h-full bg-accent/50 transition-[width] duration-300"
                        style={{ width: `${Math.round(fraction * 100)}%` }}
                      />
                    </div>
                  )}
                  {hasHeadings && isExpanded && (
                    <ul id={`outline-headings-${chapter.id}`}>
                      {headings.map((heading) => (
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
