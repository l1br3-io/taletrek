import type { PlaybackStatus } from '../hooks/useParagraphPlayer'

interface PlayerBarProps {
  status: PlaybackStatus
  playbackRate: number
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onNext: () => void
  onPrev: () => void
  onRateChange: (rate: number) => void
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

function statusLabel(status: PlaybackStatus): string {
  switch (status.type) {
    case 'idle':
      return 'Ready'
    case 'loading':
      return 'Synthesizing…'
    case 'playing':
      return 'Playing'
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
  onPlay,
  onPause,
  onStop,
  onNext,
  onPrev,
  onRateChange,
}: PlayerBarProps) {
  const isPlaying = status.type === 'playing'
  const isLoading = status.type === 'loading'
  const busy = isLoading
  return (
    <section
      className="sticky bottom-0 flex items-center gap-3 rounded-lg border border-line bg-surface p-3 shadow-lg"
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
          ⏸ Pause
        </button>
      ) : (
        <button
          type="button"
          onClick={onPlay}
          disabled={busy}
          className="rounded border border-accent bg-accent px-4 py-1 text-bg disabled:opacity-40"
          aria-label="Play"
        >
          ▶ Play
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
      <button
        type="button"
        onClick={onStop}
        className="rounded border border-line px-2 py-1"
        aria-label="Stop"
      >
        ⏹
      </button>
      <span className="min-w-[8rem] text-sm text-muted" aria-live="polite">
        {statusLabel(status)}
      </span>
      <label className="ml-auto flex items-center gap-2 text-sm text-muted">
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
    </section>
  )
}
