import { useEffect, useRef, useState } from 'react'
import type { PlaybackStatus } from '../hooks/useParagraphPlayer'

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
  /** Open the chapter outline drawer. */
  onOpenOutline?: () => void
  /** Open the per-paragraph transform modal for the current paragraph. */
  onTransformParagraph?: () => void
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

function statusLabel(status: PlaybackStatus, bufferedAhead: number): string {
  switch (status.type) {
    case 'idle':
      return 'Ready'
    case 'loading':
      return 'Synthesizing…'
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
  onOpenOutline,
  onTransformParagraph,
}: PlayerBarProps) {
  const isPlaying = status.type === 'playing'
  const isLoading = status.type === 'loading'
  const busy = isLoading
  const [menuOpen, setMenuOpen] = useState(false)
  const barRef = useRef<HTMLElement | null>(null)

  // Close the menu on outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const hasOverflow =
    !!onNextChapter ||
    !!onPrevChapter ||
    !!onGoToCurrent ||
    !!onOpenOutline ||
    !!onTransformParagraph

  return (
    <section
      ref={barRef}
      className="relative sticky bottom-0 flex items-center gap-2 rounded-lg border border-line bg-surface p-2 shadow-lg sm:gap-3 sm:p-3"
      aria-label="Audio playback"
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={busy}
        className="rounded border border-line px-2 py-1 disabled:opacity-40"
        aria-label="Previous paragraph"
      >
        ⏮
      </button>
      {isPlaying ? (
        <button
          type="button"
          onClick={onPause}
          className="rounded border border-accent bg-accent px-4 py-1 text-bg"
          aria-label="Pause"
        >
          ⏸ <span className="hidden sm:inline">Pause</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onPlay}
          disabled={busy}
          className="rounded border border-accent bg-accent px-4 py-1 text-bg disabled:opacity-40"
          aria-label="Play"
        >
          ▶ <span className="hidden sm:inline">Play</span>
        </button>
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={busy}
        className="rounded border border-line px-2 py-1 disabled:opacity-40"
        aria-label="Next paragraph"
      >
        ⏭
      </button>
      <span className="min-w-0 flex-1 truncate text-sm text-muted" aria-live="polite">
        {statusLabel(status, bufferedAhead)}
      </span>
      {hasOverflow && (
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More playback controls"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          className="rounded border border-line px-2 py-1 text-muted hover:text-fg"
        >
          ⋯
        </button>
      )}

      {menuOpen && (
        <div className="absolute bottom-full right-0 z-20 mb-2 w-56 rounded-lg border border-line bg-surface p-2 shadow-xl">
          {(!!onPrevChapter || !!onNextChapter) && (
            <div className="flex gap-2">
              {onPrevChapter && (
                <button
                  type="button"
                  onClick={() => {
                    onPrevChapter()
                    setMenuOpen(false)
                  }}
                  disabled={busy}
                  className="flex-1 rounded border border-line px-2 py-1 text-sm disabled:opacity-40"
                >
                  « Prev chapter
                </button>
              )}
              {onNextChapter && (
                <button
                  type="button"
                  onClick={() => {
                    onNextChapter()
                    setMenuOpen(false)
                  }}
                  disabled={busy}
                  className="flex-1 rounded border border-line px-2 py-1 text-sm disabled:opacity-40"
                >
                  Next chapter »
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              onStop()
              setMenuOpen(false)
            }}
            className="mt-1 block w-full rounded border border-line px-2 py-1 text-left text-sm"
          >
            ⏹ Stop
          </button>
          <label className="mt-1 flex items-center justify-between gap-2 rounded px-1 py-1 text-sm text-muted">
            Speed
            <select
              value={playbackRate}
              onChange={(e) => onRateChange(Number(e.target.value))}
              className="rounded border border-line bg-surface px-2 py-1"
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
                setMenuOpen(false)
              }}
              disabled={!hasCurrentParagraph}
              className="mt-1 block w-full rounded border border-line px-2 py-1 text-left text-sm disabled:opacity-40"
            >
              ⊙ Go to current paragraph
            </button>
          )}
          {onOpenOutline && (
            <button
              type="button"
              onClick={() => {
                onOpenOutline()
                setMenuOpen(false)
              }}
              className="mt-1 block w-full rounded border border-line px-2 py-1 text-left text-sm"
            >
              ☰ Outline
            </button>
          )}
          {onTransformParagraph && (
            <button
              type="button"
              onClick={() => {
                onTransformParagraph()
                setMenuOpen(false)
              }}
              disabled={!hasCurrentParagraph}
              className="mt-1 block w-full rounded border border-line px-2 py-1 text-left text-sm disabled:opacity-40"
            >
              ✎ Transform paragraph
            </button>
          )}
        </div>
      )}
    </section>
  )
}
