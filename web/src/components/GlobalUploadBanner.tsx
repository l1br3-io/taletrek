import { BookOpen, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import { uploadManager } from '../lib/upload/manager'
import { useUploadState } from '../lib/upload/useUpload'

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
 * Global synthesis-job banner — mounted in `Layout` so it survives route
 * changes. Shows progress while the upload manager runs a background synth
 * (upload pre-synth or per-book re-synth), plus an Open action to jump into
 * the reader (where Phase 2 streaming lets you play buffered paragraphs).
 */
export function GlobalUploadBanner() {
  const state = useUploadState()
  const navigate = useNavigate()

  if (state.type === 'idle') return null

  if (state.type === 'error') {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 border-b border-red-500/40 bg-red-500/10 px-4 py-3 text-red-400 sm:px-5"
      >
        <span className="text-sm">Synthesis failed for “{state.book.title}”.</span>
        <button
          type="button"
          onClick={() => uploadManager.dismiss()}
          aria-label="Dismiss error"
          className="text-xs text-red-400/70 hover:text-red-400"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  if (state.type === 'done') {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent-soft px-4 py-3 text-accent sm:px-5">
        <span className="text-sm">“{state.book.title}” is ready.</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(`/reader/${state.book.id}`)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-accent px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Open
          </button>
          <button
            type="button"
            onClick={() => uploadManager.dismiss()}
            aria-label="Dismiss"
            className="text-xs text-accent/70 hover:text-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  const fraction =
    state.type === 'voiceDownload' ? state.fraction : state.total > 0 ? state.done / state.total : 0

  return (
    <div
      role="status"
      className="flex flex-col gap-2 border-b border-accent/40 bg-accent-soft px-4 py-3 text-accent sm:px-5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Spinner />
          <span className="text-sm">
            {state.type === 'voiceDownload'
              ? 'Downloading voice…'
              : state.total > 0
                ? `Synthesizing “${state.book.title}”… ${state.done} / ${state.total}`
                : `Synthesizing “${state.book.title}”…`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(`/reader/${state.book.id}`)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-accent px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Open
          </button>
          <button
            type="button"
            onClick={() => uploadManager.cancel()}
            className="text-xs text-accent/70 hover:text-accent"
          >
            Cancel
          </button>
        </div>
      </div>
      <ProgressBar fraction={fraction} />
    </div>
  )
}
