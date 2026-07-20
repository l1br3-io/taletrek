import type { KeyboardEvent, RefObject } from 'react'
import type { Book, Chapter } from '../../types'
import { PreparingElapsedTimer, Spinner, StreamChip, StreamingCursor } from './StreamingBlock'

/**
 * Whole-book generation state for the reader. When non-null, the reader
 * switches to "generation mode":
 * - Chapters before `activeChapterIndex` render normally (committed).
 * - The active chapter renders **in-place streaming paragraphs**: parsed
 *   paragraphs from the live token stream replace the chapter's slots
 *   one-by-one as they arrive (last = in-progress with cursor).
 *   - `isReductive === false` (cleanup/simplify): slot-preserving — new
 *     paragraphs map to `chapter.paragraphs[chunkStartIndex + N]`; slots
 *     beyond the streamed range render old text dimmed.
 *   - `isReductive === true` (summarize): wholesale replace — old
 *     paragraphs disappear, only the streaming paragraphs render (last
 *     has cursor).
 * - Chapters after `activeChapterIndex` render with a subtle "pending" wash
 *   so the user can see what's coming.
 *
 * While `streamingParagraphs === null` (preparing — waiting for the first
 * token from the provider, which can take minutes on slow / free-tier
 * models), the active chapter shows an inline "preparing" chip at the top
 * so the user sees feedback even if they scroll past the bottom bar.
 *
 * `null` = no generation in progress — reader renders as before.
 */
export interface GenerationMode {
  /** Index of the chapter currently being generated (or just completed). */
  activeChapterIndex: number
  /** True while the job is running; false when paused/error/done. */
  running: boolean
  /** Top-level op label (used as fallback when streamingParagraphs is null). */
  opLabel: string
  /** `performance.now()` when the current chapter's transform call began. */
  chapterStartedAt: number
  /** Live in-place streaming paragraphs for the active chapter; null between chunks. */
  streamingParagraphs: {
    opLabel: string
    isReductive: boolean
    chunkStartIndex: number
    chunkInputCount: number
    chunkIndex: number
    chunkTotal: number
    paragraphs: string[]
    /**
     * Live reasoning text from reasoning models (empty for non-reasoning).
     * Surfaced in the preparing chip so the user sees the model is "thinking"
     * rather than staring at an opaque wait.
     */
    reasoning: string
  } | null
}

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
  /** Whole-book generation state (M13). */
  generation?: GenerationMode | null
  /**
   * Mobile FFmpeg lockdown (M11 / issue #4): when true, paragraph clicks
   * must NOT seek — the m4a isn't ready and the player's `seekToParagraph`
   * would synthesize on demand via the desktop fallback. PlayerBar already
   * disables its transport buttons; this extends the lockdown to the body.
   */
  synthLockdown?: boolean
}

interface ParagraphItem {
  id: string
  text: string
  /** True on the in-progress slot (last streamed paragraph — gets `█`). */
  streaming?: boolean
  /** True on slots not yet streamed (preserve mode only — render dimmed). */
  dimmed?: boolean
}

function paragraphItems(paragraphs: readonly string[], chapterId: string): ParagraphItem[] {
  return paragraphs.map((text, index) => ({ id: `${chapterId}:${index}`, text }))
}

/**
 * Compute the paragraph view for an active chapter under whole-book generation.
 *
 * Two modes (matches ADR-0012 / gotcha #26 in-place streaming revision):
 * - **Preserve** (`isReductive === false`, e.g. cleanup/simplify): the
 *   chapter's existing slots are kept; streaming paragraphs overwrite them
 *   one-by-one starting at `chunkStartIndex`. The last streamed paragraph is
 *   marked `streaming` (gets the cursor). Slots past the streamed range are
 *   rendered with their original text and `dimmed` (faded) so the user can
 *   see what's still pending. Slots before `chunkStartIndex` (already
 *   committed by a previous chunk) render normally.
 * - **Replace** (`isReductive === true`, e.g. summarize): the chapter's
 *   original paragraphs are hidden entirely; only the streaming paragraphs
 *   render, last = cursor. The chapter visually "collapses then grows" —
 *   ChatGPT-summarize style.
 *
 * The split between modes mirrors what happens at chunk commit: non-reductive
 * maps 1:1 to existing slots (count preserved), reductive replaces wholesale
 * (count differs). The visual during streaming matches the post-commit reality.
 */
function streamingParagraphView(
  chapter: Chapter,
  sp: NonNullable<GenerationMode['streamingParagraphs']>,
): ParagraphItem[] {
  if (sp.isReductive) {
    // Replace mode: render only streaming paragraphs.
    // Synthetic IDs (slot indices will change at commit anyway).
    if (sp.paragraphs.length === 0) {
      // Placeholder so the chapter doesn't visually vanish before the
      // first token arrives — preserves the "something is happening"
      // contract while paragraphs are still empty.
      return [
        {
          id: `${chapter.id}:stream:placeholder`,
          text: '',
          streaming: true,
        },
      ]
    }
    return sp.paragraphs.map((text, i) => ({
      id: `${chapter.id}:stream:${i}`,
      text,
      streaming: i === sp.paragraphs.length - 1,
    }))
  }
  // Preserve mode: slot-by-slot replacement against chapter.paragraphs.
  const result: ParagraphItem[] = []
  const streamingEnd = sp.chunkStartIndex + sp.paragraphs.length
  const slots = chapter.paragraphs.length
  for (let i = 0; i < slots; i++) {
    if (i < sp.chunkStartIndex) {
      // Committed by a previous chunk — render normally.
      result.push({ id: `${chapter.id}:${i}`, text: chapter.paragraphs[i] ?? '' })
    } else if (i < streamingEnd) {
      // In streaming range — render new text.
      const streamingText = sp.paragraphs[i - sp.chunkStartIndex] ?? ''
      const isLastStreamed = i === streamingEnd - 1
      result.push({
        id: `${chapter.id}:${i}`,
        text: streamingText,
        streaming: isLastStreamed,
      })
    } else {
      // Not yet streamed — render old text dimmed.
      result.push({
        id: `${chapter.id}:${i}`,
        text: chapter.paragraphs[i] ?? '',
        dimmed: true,
      })
    }
  }
  // Surplus: model output more paragraphs than the chunk's input count
  // (rare for non-reductive — the prompt says preserve count). Append as
  // extra slots so the user sees the model is "ahead" of itself.
  const expectedEnd = sp.chunkStartIndex + sp.chunkInputCount
  if (streamingEnd > expectedEnd && sp.chunkInputCount > 0) {
    for (let j = expectedEnd; j < streamingEnd; j++) {
      const surplusIdx = j - sp.chunkStartIndex
      if (surplusIdx < 0 || surplusIdx >= sp.paragraphs.length) continue
      result.push({
        id: `${chapter.id}:surplus:${j}`,
        text: sp.paragraphs[surplusIdx] ?? '',
        streaming: j === streamingEnd - 1,
      })
    }
  }
  return result
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
  generation,
  synthLockdown,
}: ReaderViewProps) {
  const multi = chapters.length > 1
  return (
    <article className="space-y-6 sm:space-y-8">
      {/* Visually-hidden SR-only status region. The streaming <p> below is
          aria-live="off" so a token flood doesn't drown the announcement
          queue; this region announces start/done in one phrase each. */}
      <span className="sr-only" aria-live="polite" data-testid="stream-status">
        {stream
          ? `AI ${stream.opLabel} started`
          : generation && generation.running
            ? `AI ${generation.streamingParagraphs?.opLabel ?? 'generation'} started`
            : /* clean render with no tokens = idle */ ''}
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
      {chapters.map((chapter, chapterIdx) => {
        const isGenerationActive =
          !!generation && generation.activeChapterIndex === chapterIdx && generation.running
        const isPending = !!generation && chapterIdx > generation.activeChapterIndex
        // Compute paragraph view: in-place streaming for the active chapter,
        // normal rendering otherwise. The streaming view replaces old text
        // slot-by-slot (preserve) or wholesale (replace) — see
        // `streamingParagraphView`.
        const items =
          isGenerationActive && generation?.streamingParagraphs
            ? streamingParagraphView(chapter, generation.streamingParagraphs)
            : paragraphItems(chapter.paragraphs, chapter.id)
        // Op label for the StreamChip above the first streaming paragraph in
        // this chapter (M13 in-place visual signature — keeps parity with the
        // F8 per-paragraph stream's chip).
        const m13OpLabel =
          isGenerationActive && generation?.streamingParagraphs
            ? generation.streamingParagraphs.opLabel
            : null
        return (
          <section
            key={chapter.id}
            className={`space-y-4 ${isPending ? 'opacity-40' : ''}`}
            data-pending={isPending ? 'true' : undefined}
          >
            {multi && <h2 className="text-base font-semibold text-fg">{chapter.title}</h2>}
            <div className="tt-reader-text space-y-4 text-fg">
              {/* Inline preparing chip — shown while the active chapter is
                  waiting for its first CONTENT token from the provider.
                  Reasoning models (glm-5.2, DeepSeek-R1, etc.) may stream
                  `reasoning_content` tokens first — those are surfaced inside
                  the chip so the user sees the model is "thinking" rather
                  than staring at an opaque wait. Once content paragraphs
                  begin arriving, the chip disappears and in-place streaming
                  takes over.

                  The unified bottom PlayerBar (which swaps to generation
                  mode — see `GenerationBar` in `PlayerBar.tsx`) shows the
                  same info, but the user may have scrolled past it; this
                  chip stays anchored to the chapter so the "preparing"
                  state is always visible alongside the about-to-be-
                  transformed text. */}
              {isGenerationActive &&
              generation?.streamingParagraphs !== null &&
              generation.streamingParagraphs.paragraphs.length === 0 &&
              generation.streamingParagraphs.reasoning &&
              generation.streamingParagraphs.reasoning.length > 0 ? (
                // Reasoning is flowing but no content yet — show reasoning
                // snippet inside the chip.
                <div
                  className="space-y-2 rounded-md border border-accent/60 bg-accent-soft px-3 py-2 text-accent"
                  data-testid="chapter-preparing-chip"
                >
                  <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em]">
                    <Spinner />
                    <span>{generation.opLabel}</span>
                    <span aria-hidden>·</span>
                    <span>thinking</span>
                    <span
                      aria-hidden
                      className="mx-1 flex-1 border-b border-dotted border-accent/40"
                    />
                    <PreparingElapsedTimer startedAt={generation.chapterStartedAt} />
                  </div>
                  {/* Live reasoning snippet — most recent ~200 chars so the
                      user sees what the model is currently considering
                      without overwhelming the chip. */}
                  <div
                    className="max-h-24 overflow-hidden font-mono text-[10px] leading-relaxed text-accent/70"
                    data-testid="preparing-reasoning"
                  >
                    {generation.streamingParagraphs.reasoning.slice(-200)}
                  </div>
                </div>
              ) : isGenerationActive &&
                (generation?.streamingParagraphs === null ||
                  generation.streamingParagraphs.paragraphs.length === 0) ? (
                // Preparing — no tokens yet (or only reasoning tokens that
                // we didn't get yet). Spinner + elapsed.
                <div
                  className="flex items-center gap-2 rounded-md border border-accent/60 bg-accent-soft px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-accent"
                  data-testid="chapter-preparing-chip"
                >
                  <Spinner />
                  <span>{generation.opLabel}</span>
                  <span aria-hidden>·</span>
                  <span>preparing chapter</span>
                  <span
                    aria-hidden
                    className="mx-1 flex-1 border-b border-dotted border-accent/40"
                  />
                  <PreparingElapsedTimer startedAt={generation.chapterStartedAt} />
                </div>
              ) : null}
              {items.map((item, itemIdx) => {
                // F8 per-paragraph stream (separate from M13 whole-book).
                const f8Streaming = !!stream && stream.paragraphId === item.id
                // M13 streaming flag from the view (last in-progress slot).
                const m13Streaming = !!item.streaming
                const anyStreaming = f8Streaming || m13Streaming
                // Streaming wins over active/pulsing for the duration of the rewrite.
                const active = !anyStreaming && item.id === currentParagraphId
                const seekable = !anyStreaming && !!onSeekParagraph && !generation && !synthLockdown
                const pulsing = !anyStreaming && item.id === pulseParagraphId
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
                const f8StreamState = f8Streaming && stream ? stream : null
                // Render the StreamChip only on the FIRST streaming slot of
                // an M13 active chapter (so the chip appears once, above the
                // growing region — not on every paragraph).
                const showM13Chip =
                  m13Streaming && m13OpLabel && itemIdx === items.findIndex((i) => i.streaming)
                return (
                  <div key={item.id} className="space-y-1.5">
                    {f8StreamState && (
                      <StreamChip opLabel={f8StreamState.opLabel} onStop={onStopStream} />
                    )}
                    {showM13Chip && <StreamChip opLabel={m13OpLabel} />}
                    <p
                      ref={active && activeParagraphRef ? activeParagraphRef : undefined}
                      aria-live={anyStreaming ? 'off' : undefined}
                      data-streaming={anyStreaming ? 'true' : undefined}
                      data-dimmed={item.dimmed ? 'true' : undefined}
                      className={[
                        active
                          ? 'bg-accent-soft p-2 -mx-2 ring-1 ring-accent'
                          : seekable
                            ? 'cursor-pointer'
                            : '',
                        anyStreaming ? 'tt-streaming' : '',
                        item.dimmed ? 'opacity-50' : '',
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
                      {f8StreamState ? f8StreamState.streamingText : item.text}
                      {anyStreaming && <StreamingCursor />}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </article>
  )
}
