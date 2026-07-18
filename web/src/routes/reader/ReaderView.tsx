import { Square } from 'lucide-react'
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
   * paragraphs show nothing. Passed both during active synth (live job
   * progress) and during normal reading (persistent cache probe).
   */
  bufferedParagraphIds?: Set<string>
  /**
   * Live AI-stream state. When non-null, that paragraph renders its body as
   * `stream.streamingText` with a trailing blinking `█` cursor, a hairline
   * accent left border (`.tt-streaming`), and a sibling mono chip
   * (`❯ {opLabel} ── ■ Stop`) above it. The paragraph yields its seek and
   * active-paragraph states to the streaming state until commit.
   */
  stream?: {
    paragraphId: string
    opLabel: string
    streamingText: string
  } | null
  /** Abort the in-flight AI stream (Stop chip + Esc). */
  onStopStream?: () => void
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
  stream,
  onStopStream,
}: ReaderViewProps) {
  const multi = chapters.length > 1
  return (
    <article className="space-y-6 sm:space-y-8">
      {/* Visually-hidden SR-only status region. The streaming <p> below is
          aria-live="off" so a token flood doesn't drown the announcement
          queue; this region announces start/done in one phrase each. */}
      <span className="sr-only" aria-live="polite" data-testid="stream-status">
        {stream ? `AI ${stream.opLabel} started` : /* clean render with no tokens = idle */ ''}
      </span>
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
      {chapters.map((chapter) => (
        <section key={chapter.id} className="space-y-4">
          {multi && <h2 className="text-base font-semibold text-fg">{chapter.title}</h2>}
          <div className="tt-reader-text space-y-4 text-fg">
            {paragraphItems(chapter.paragraphs, chapter.id).map((item) => {
              const streaming = !!stream && stream.paragraphId === item.id
              // Streaming wins over active/pulsing for the duration of the rewrite.
              const active = !streaming && item.id === currentParagraphId
              const seekable = !streaming && !!onSeekParagraph
              const pulsing = !streaming && item.id === pulseParagraphId
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
              const streamState = streaming && stream ? stream : null
              return (
                <div key={item.id} className="space-y-1.5">
                  {streamState && (
                    <div
                      className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-accent"
                      data-testid="stream-chip"
                    >
                      <span aria-hidden>❯</span>
                      <span>{streamState.opLabel}</span>
                      <span
                        aria-hidden
                        className="mx-1 flex-1 border-b border-dotted border-line"
                      />
                      <button
                        type="button"
                        onClick={onStopStream}
                        className="inline-flex items-center gap-1 rounded-md border border-accent px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-accent transition-colors hover:bg-accent hover:text-bg"
                        aria-label={`Stop ${streamState.opLabel}`}
                      >
                        <Square className="h-2.5 w-2.5 fill-current" aria-hidden />
                        Stop
                      </button>
                    </div>
                  )}
                  <p
                    ref={active && activeParagraphRef ? activeParagraphRef : undefined}
                    aria-live={streaming ? 'off' : undefined}
                    className={[
                      active
                        ? 'bg-accent-soft p-2 -mx-2 ring-1 ring-accent'
                        : seekable
                          ? 'cursor-pointer'
                          : '',
                      streaming ? 'tt-streaming' : '',
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
                    {streamState ? streamState.streamingText : item.text}
                    {streamState && (
                      <span className="tt-cursor text-accent" aria-hidden>
                        █
                      </span>
                    )}
                  </p>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </article>
  )
}
