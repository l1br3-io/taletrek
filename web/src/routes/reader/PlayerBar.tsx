import {
  ArrowUp,
  ChevronsLeft,
  ChevronsRight,
  List,
  Locate,
  MoreHorizontal,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
  Wand2,
  X,
} from 'lucide-react'
import { Menu } from '../../components/Menu'
import type { BookTransformState } from '../../lib/transform/manager'
import type { PlaybackStatus } from './players/types'
import { PreparingElapsedTimer, Spinner } from './StreamingBlock'

interface PlayerBarProps {
  status: PlaybackStatus
  playbackRate: number
  /** Paragraphs pre-rendered ahead of the pointer (0 when none ready). */
  bufferedAhead?: number
  /** Whether a current paragraph exists (enables "go to current"). */
  hasCurrentParagraph?: boolean
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onNext: () => void
  onPrev: () => void
  /** Skip to the next chapter (lock-screen parity). */
  onNextChapter?: () => void
  /** Skip to the previous chapter (lock-screen parity). */
  onPrevChapter?: () => void
  onRateChange: (rate: number) => void
  /** Scroll the view to the currently active paragraph. */
  onGoToCurrent?: () => void
  /** Scroll the page back to the top (global nav, book header). */
  onScrollToTop?: () => void
  /** Open the chapter outline drawer. */
  onOpenOutline?: () => void
  /** Open the per-paragraph transform modal for the current paragraph. */
  onTransformParagraph?: () => void
  /**
   * Mobile synthesis lockdown (ADR-0010 / M11). When true, playback controls are
   * disabled — on mobile, playback during synthesis would fall back to the
   * lock-broken per-paragraph engine, so the reader pins to a synthesis mode.
   */
  synthLockdown?: boolean
  /** Status label shown while `synthLockdown` is active (e.g. "Synthesizing… 12/42"). */
  lockdownLabel?: string
  /**
   * Whole-book AI generation state (M13 / ADR-0012). When present and not
   * `done`, the bar swaps its body from playback controls to a single-row
   * generation status with a full-bleed progress tape at the viewport's
   * bottom edge. Playback props are ignored in this mode — generation is a
   * deliberate mode shift, not a parallel one.
   */
  generation?: GenerationProps | null
}

export interface GenerationProps {
  /**
   * The transform manager's state. `'idle'` is excluded by the caller
   * (ReaderPane only builds `generationProps` when `transformForThisBook`
   * is non-null); `'done'` is excluded because `PlayerBar` returns null
   * for that case before rendering `GenerationBar`.
   */
  state: Exclude<BookTransformState, { type: 'idle' } | { type: 'done' }>
  totalChapters: number
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

function statusLabel(status: PlaybackStatus, bufferedAhead: number): string {
  switch (status.type) {
    case 'idle':
      return 'Ready'
    case 'loading':
      return 'Synthesizing…'
    case 'buffering':
      return 'Buffering…'
    case 'playing':
      return bufferedAhead > 0 ? 'Playing' : 'Playing · buffering…'
    case 'paused':
      return 'Paused'
    case 'ended':
      return 'Finished'
    case 'error':
      return status.message
  }
}

export function PlayerBar(props: PlayerBarProps) {
  // Generation mode: swap the entire body. The bar stays in the same sticky
  // bottom slot — playback users already know to look here for transport, and
  // during generation the same slot becomes the rewrite readout. One bar, not
  // two; the inline `GenerationBanner` above the reader is gone.
  if (props.generation) {
    return <GenerationBar {...props.generation} />
  }
  return <PlaybackBar {...props} />
}

// ---------------------------------------------------------------------------
// Playback mode (default)
// ---------------------------------------------------------------------------

function PlaybackBar({
  status,
  playbackRate,
  bufferedAhead = 0,
  hasCurrentParagraph = false,
  onPlay,
  onPause,
  onStop,
  onNext,
  onPrev,
  onNextChapter,
  onPrevChapter,
  onRateChange,
  onGoToCurrent,
  onScrollToTop,
  onOpenOutline,
  onTransformParagraph,
  synthLockdown = false,
  lockdownLabel,
}: PlayerBarProps) {
  const isPlaying = status.type === 'playing'
  const isLoading = status.type === 'loading' || status.type === 'buffering'
  const busy = isLoading
  // During mobile synthesis lockdown, all playback controls are disabled.
  const playbackDisabled = busy || synthLockdown

  const hasOverflow =
    !!onNextChapter ||
    !!onPrevChapter ||
    !!onGoToCurrent ||
    !!onScrollToTop ||
    !!onOpenOutline ||
    !!onTransformParagraph

  return (
    <section
      className="sticky bottom-0 flex items-center gap-2 border border-line bg-surface p-2 shadow-lg sm:gap-3 sm:p-3"
      aria-label="Audio playback"
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={playbackDisabled}
        className="border border-line px-2 py-1 disabled:opacity-40"
        aria-label="Previous paragraph"
      >
        <SkipBack className="h-5 w-5" />
      </button>
      {isPlaying && !synthLockdown ? (
        <button
          type="button"
          onClick={onPause}
          className="inline-flex items-center justify-center gap-1 border border-accent bg-accent px-4 py-1 text-bg"
          aria-label="Pause"
        >
          <Pause className="h-4 w-4" /> <span className="hidden sm:inline">Pause</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onPlay}
          disabled={playbackDisabled}
          className="inline-flex items-center justify-center gap-1 border border-accent bg-accent px-4 py-1 text-bg disabled:opacity-40"
          aria-label="Play"
        >
          <Play className="h-4 w-4" /> <span className="hidden sm:inline">Play</span>
        </button>
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={playbackDisabled}
        className="border border-line px-2 py-1 disabled:opacity-40"
        aria-label="Next paragraph"
      >
        <SkipForward className="h-5 w-5" />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm text-muted" aria-live="polite">
        {synthLockdown && lockdownLabel ? lockdownLabel : statusLabel(status, bufferedAhead)}
      </span>
      {hasOverflow && (
        <Menu
          placement="top-end"
          panelClassName="w-56 border border-line bg-surface p-2 shadow-xl"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label="More playback controls"
              className="border border-line px-2 py-1 text-muted hover:text-fg"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          )}
        >
          {(close) => (
            <>
              {(!!onPrevChapter || !!onNextChapter) && (
                <div className="flex gap-2">
                  {onPrevChapter && (
                    <button
                      type="button"
                      onClick={() => {
                        onPrevChapter()
                        close()
                      }}
                      disabled={busy}
                      className="flex flex-1 items-center justify-center gap-1 border border-line px-2 py-1 text-sm disabled:opacity-40"
                    >
                      <ChevronsLeft className="h-4 w-4" /> Prev chapter
                    </button>
                  )}
                  {onNextChapter && (
                    <button
                      type="button"
                      onClick={() => {
                        onNextChapter()
                        close()
                      }}
                      disabled={busy}
                      className="flex flex-1 items-center justify-center gap-1 border border-line px-2 py-1 text-sm disabled:opacity-40"
                    >
                      Next chapter <ChevronsRight className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  onStop()
                  close()
                }}
                disabled={synthLockdown}
                className="mt-1 flex w-full items-center gap-2 border border-line px-2 py-1 text-sm disabled:opacity-40"
              >
                <Square className="h-4 w-4" /> Stop
              </button>
              <label className="mt-1 flex items-center justify-between gap-2 px-1 py-1 text-sm text-muted">
                Speed
                <select
                  value={playbackRate}
                  onChange={(e) => onRateChange(Number(e.target.value))}
                  className="border border-line bg-surface px-2 py-1"
                >
                  {RATES.map((r) => (
                    <option key={r} value={r}>
                      {r}×
                    </option>
                  ))}
                </select>
              </label>
              {onGoToCurrent && (
                <button
                  type="button"
                  onClick={() => {
                    onGoToCurrent()
                    close()
                  }}
                  disabled={!hasCurrentParagraph}
                  className="mt-1 flex w-full items-center gap-2 border border-line px-2 py-1 text-sm disabled:opacity-40"
                >
                  <Locate className="h-4 w-4" /> Go to current paragraph
                </button>
              )}
              {onScrollToTop && (
                <button
                  type="button"
                  onClick={() => {
                    onScrollToTop()
                    close()
                  }}
                  className="mt-1 flex w-full items-center gap-2 border border-line px-2 py-1 text-sm"
                >
                  <ArrowUp className="h-4 w-4" /> Back to top
                </button>
              )}
              {onOpenOutline && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenOutline()
                    close()
                  }}
                  className="mt-1 flex w-full items-center gap-2 border border-line px-2 py-1 text-sm"
                >
                  <List className="h-4 w-4" /> Outline
                </button>
              )}
              {onTransformParagraph && (
                <button
                  type="button"
                  onClick={() => {
                    onTransformParagraph()
                    close()
                  }}
                  disabled={!hasCurrentParagraph}
                  className="mt-1 flex w-full items-center gap-2 border border-line px-2 py-1 text-sm disabled:opacity-40"
                >
                  <Wand2 className="h-4 w-4" /> Transform paragraph
                </button>
              )}
            </>
          )}
        </Menu>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Generation mode (M13 / ADR-0012)
//
// Single sticky row at the bottom of the viewport carrying the whole-book
// rewrite status: opLabel + chapter X/Y + N% + Pause/Resume/Cancel. The
// full-bleed progress tape runs along the absolute bottom edge of the
// viewport — the page-scale version of the existing `.tt-streaming` 2px
// accent motif. During the preparing phase (no tokens yet — provider prefill
// can be minutes on slow models), the spinner replaces `❯` and an inline
// elapsed counter replaces the percentage.
// ---------------------------------------------------------------------------

function GenerationBar({ state, totalChapters, onPause, onResume, onCancel }: GenerationProps) {
  if (state.type === 'error') {
    return (
      <section
        className="sticky bottom-0 z-30 border-t border-danger/40 bg-danger-soft shadow-lg"
        aria-label="AI generation failed"
        data-testid="generation-banner"
      >
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-danger sm:px-4">
          <X className="h-3 w-3" aria-hidden />
          <span className="truncate">{state.message}</span>
          <span aria-hidden className="mx-1 flex-1 border-b border-dotted border-danger/40" />
          <button
            type="button"
            onClick={onResume}
            className="inline-flex items-center gap-1 border border-danger px-2 py-0.5 uppercase tracking-[0.08em] hover:bg-danger hover:text-bg"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 border border-danger px-2 py-0.5 hover:bg-danger hover:text-bg"
            aria-label="Dismiss error"
          >
            <X className="h-2.5 w-2.5" aria-hidden />
          </button>
        </div>
        <div className="h-0.5 w-full bg-danger/40" aria-hidden />
      </section>
    )
  }

  const running = state.type === 'running'
  const done = state.done
  const total = state.total
  const opLabel = running ? state.opLabel : 'paused'
  const chapterIdx = running ? state.currentChapterIndex : undefined
  const sp = running ? state.streamingParagraphs : null
  // Intra-chunk fraction: a long single-chunk chapter would otherwise sit
  // at 0% for the entire stream — looking "stuck" while tokens flow.
  const intraChunk =
    sp && sp.chunkInputCount > 0 ? Math.min(1, sp.paragraphs.length / sp.chunkInputCount) : 0
  const chunkAdjusted = sp ? sp.chunkIndex + intraChunk : 0
  const chapterFraction = sp ? chunkAdjusted / Math.max(1, sp.chunkTotal) : 0
  const fraction = total > 0 ? Math.min(1, (done + chapterFraction) / total) : 0
  const preparing = running && (!sp || sp.paragraphs.length === 0)
  const chapterStartedAt = running ? state.chapterStartedAt : null
  const dangerFill = false // reserved for error variant above

  return (
    <section
      className="sticky bottom-0 z-30 border-t border-accent/40 bg-accent-soft shadow-lg"
      aria-label="AI generation in progress"
      data-testid="generation-banner"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-accent sm:px-4">
        {preparing ? <Spinner className="h-3 w-3" /> : <span aria-hidden>❯</span>}
        <span className="truncate">{opLabel}</span>
        <span aria-hidden className="mx-1 flex-1 border-b border-dotted border-accent/40" />
        {preparing && chapterStartedAt !== null ? (
          <span
            className="flex shrink-0 items-center gap-1.5 text-accent/70"
            data-testid="preparing-status"
          >
            <span className="hidden sm:inline">waiting</span>
            <PreparingElapsedTimer startedAt={chapterStartedAt} />
          </span>
        ) : (
          <span className="shrink-0 tabular-nums">
            {chapterIdx !== undefined ? `ch ${chapterIdx + 1}/${totalChapters}` : ''}
            {chapterIdx !== undefined ? ' · ' : ''}
            {Math.round(fraction * 100)}%
          </span>
        )}
        {running ? (
          <button
            type="button"
            onClick={onPause}
            className="inline-flex shrink-0 items-center gap-1 border border-accent px-2 py-0.5 hover:bg-accent hover:text-bg"
            aria-label="Pause generation"
          >
            <Pause className="h-2.5 w-2.5 fill-current" aria-hidden />
            <span className="hidden sm:inline">Pause</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onResume}
            className="inline-flex shrink-0 items-center gap-1 border border-accent px-2 py-0.5 hover:bg-accent hover:text-bg"
            aria-label="Resume generation"
          >
            <Play className="h-2.5 w-2.5 fill-current" aria-hidden />
            <span className="hidden sm:inline">Resume</span>
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex shrink-0 items-center gap-1 border border-accent px-2 py-0.5 hover:bg-accent hover:text-bg"
          aria-label="Cancel generation"
        >
          <X className="h-2.5 w-2.5" aria-hidden />
          <span className="hidden sm:inline">Cancel</span>
        </button>
      </div>
      {/* Full-bleed progress tape — the page-scale version of `.tt-streaming`'s
          2px accent rule. Sits at the absolute bottom edge of the viewport so
          it reads as "the page is filling up", not "a UI element reporting a
          number". The only ambient animation at the chrome layer during
          steady-state streaming; everything else holds still. */}
      <div className={`h-0.5 w-full ${dangerFill ? 'bg-danger/30' : 'bg-accent/20'}`} aria-hidden>
        <div
          className={`h-full transition-[width] duration-300 ease-out ${dangerFill ? 'bg-danger' : 'bg-accent'}`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </section>
  )
}
