import { AUDIO_CACHE_BUDGET_BYTES } from '../lib/db'

interface AudioCacheIndicatorProps {
  /** Current cache size in bytes, or null while loading / on error. */
  sizeBytes: number | null
  /** Called when the user clicks Clear. The parent owns the clear + refresh. */
  onClear: () => void
  /** Whether a Clear is in progress (disables the button). */
  clearing?: boolean
}

/** Format bytes as "X MB" (1 decimal place). */
function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

/**
 * Read-only audio cache indicator + Clear button (M8). Presentational — the
 * container (`Settings`) owns the data via `useAudioCacheStats` and the clear
 * action via `clearAudioCache`. Shows "Cached audio: X MB / 500 MB" and a
 * Clear button.
 */
export function AudioCacheIndicator({
  sizeBytes,
  onClear,
  clearing = false,
}: AudioCacheIndicatorProps) {
  const label =
    sizeBytes === null
      ? 'Cached audio: …'
      : `Cached audio: ${formatMB(sizeBytes)} / ${formatMB(AUDIO_CACHE_BUDGET_BYTES)}`

  return (
    <div className="flex items-center justify-between rounded-lg border border-line p-3">
      <span className="text-sm text-fg">{label}</span>
      <button
        type="button"
        onClick={onClear}
        disabled={clearing || sizeBytes === 0}
        className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-red-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {clearing ? 'Clearing…' : 'Clear'}
      </button>
    </div>
  )
}
