import { X } from 'lucide-react'
import type { UploadState } from '../hooks/useBookUpload'

interface UploadProgressProps {
  state: UploadState
  onStartReading: () => void
  onDismiss: () => void
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden
    />
  )
}

function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100)
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-accent/20">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/**
 * Upload progress UI: parse spinner, voice-download bar, synthesis progress
 * with "Start reading" skip button, and error banner. Presentational — the
 * container owns the state via `useBookUpload` and the action callbacks.
 */
export function UploadProgress({ state, onStartReading, onDismiss }: UploadProgressProps) {
  if (state.type === 'idle') return null

  if (state.type === 'error') {
    return (
      <div
        role="alert"
        className="flex items-center justify-between rounded-lg border border-red-500 bg-red-500/10 p-4 text-red-400"
      >
        <span className="text-sm">{state.message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="ml-4 text-xs text-red-400/70 hover:text-red-400"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  if (state.type === 'parsing') {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-lg border border-accent bg-accent-soft p-4 text-accent"
      >
        <Spinner />
        <span className="text-sm">Parsing “{state.fileName}”…</span>
      </div>
    )
  }

  if (state.type === 'voiceDownload') {
    return (
      <div
        role="status"
        className="space-y-3 rounded-lg border border-accent bg-accent-soft p-4 text-accent"
      >
        <div className="flex items-center gap-3">
          <Spinner />
          <span className="text-sm">Downloading voice for “{state.fileName}”…</span>
        </div>
        <ProgressBar fraction={state.fraction} />
        <button
          type="button"
          onClick={onStartReading}
          className="rounded-lg border border-accent px-4 py-2 text-sm font-medium transition-colors hover:bg-elevated"
        >
          Start reading
        </button>
      </div>
    )
  }

  // synthesizing
  const fraction = state.total > 0 ? state.done / state.total : 0
  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-accent bg-accent-soft p-4 text-accent"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Spinner />
          <span className="text-sm">
            Preparing audiobook…{' '}
            <span className="tabular-nums">
              {state.done} / {state.total}
            </span>
          </span>
        </div>
      </div>
      <ProgressBar fraction={fraction} />
      <button
        type="button"
        onClick={onStartReading}
        className="rounded-lg border border-accent px-4 py-2 text-sm font-medium transition-colors hover:bg-elevated"
      >
        Start reading
      </button>
    </div>
  )
}
