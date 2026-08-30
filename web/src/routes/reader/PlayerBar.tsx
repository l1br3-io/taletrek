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
} from 'lucide-react'
import { Menu } from '../../components/Menu'
import type { PlaybackStatus } from './players/types'

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
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

function statusLabel(status: PlaybackStatus, bufferedAhead: number): string {
  switch (status.type) {
    case 'idle':
      return 'Ready'
    case 'loading':
      return 'Preparing…'
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

export function PlayerBar({
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
}: PlayerBarProps) {
  const isPlaying = status.type === 'playing'
  const isLoading = status.type === 'loading' || status.type === 'buffering'
  const busy = isLoading

  const hasOverflow =
    !!onNextChapter || !!onPrevChapter || !!onGoToCurrent || !!onScrollToTop || !!onOpenOutline

  return (
    <section
      className="sticky bottom-0 flex items-center gap-2 border border-line bg-surface p-2 shadow-lg sm:gap-3 sm:p-3"
      aria-label="Audio playback"
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={busy}
        className="border border-line px-2 py-1 disabled:opacity-40"
        aria-label="Previous paragraph"
      >
        <SkipBack className="h-5 w-5" />
      </button>
      {isPlaying ? (
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
          disabled={busy}
          className="inline-flex items-center justify-center gap-1 border border-accent bg-accent px-4 py-1 text-bg disabled:opacity-40"
          aria-label="Play"
        >
          <Play className="h-4 w-4" /> <span className="hidden sm:inline">Play</span>
        </button>
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={busy}
        className="border border-line px-2 py-1 disabled:opacity-40"
        aria-label="Next paragraph"
      >
        <SkipForward className="h-5 w-5" />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm text-muted" aria-live="polite">
        {statusLabel(status, bufferedAhead)}
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
                className="mt-1 flex w-full items-center gap-2 border border-line px-2 py-1 text-sm"
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
            </>
          )}
        </Menu>
      )}
    </section>
  )
}
