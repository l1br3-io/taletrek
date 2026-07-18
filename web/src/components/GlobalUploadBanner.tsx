import { BookOpen, Pause, Play, RotateCcw, X } from 'lucide-react'
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
    <div className="h-2 w-full bg-accent/20">
      <div
        className="h-full bg-accent transition-[width] duration-300"
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
    const isResynth = state.mode === 'resynth'
    const canRetry = isResynth || state.retryable
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger/10 px-4 py-3 text-danger sm:px-5"
      >
        <span className="text-sm">
          {isResynth
            ? `Couldn't update audio for “${state.book.title}”. Your text is safe — retry when ready.`
            : canRetry
              ? `Synthesis failed for “${state.book.title}”. Your book is safe — retry when ready.`
              : `Synthesis failed for “${state.book.title}”.`}
        </span>
        <div className="flex items-center gap-3">
          {canRetry && (
            <button
              type="button"
              onClick={() => uploadManager.retry()}
              aria-label="Retry synthesis"
              className="inline-flex items-center gap-1.5 border border-danger px-3 py-1.5 text-xs font-medium transition-colors hover:bg-danger/10"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={() => uploadManager.dismiss()}
            aria-label="Dismiss error"
            className="text-xs text-danger/70 hover:text-danger"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  if (state.type === 'done') {
    const isResynth = state.mode === 'resynth'
    return (
      <div className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent-soft px-4 py-3 text-accent sm:px-5">
        <span className="text-sm">
          {isResynth
            ? `Audio updated for “${state.book.title}”.`
            : `“${state.book.title}” is ready.`}
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(`/reader/${state.book.id}`)}
            className="inline-flex items-center gap-1.5 border border-accent px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
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

  if (state.type === 'paused') {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent-soft px-4 py-3 text-accent sm:px-5"
      >
        <span className="text-sm">
          Paused “{state.book.title}” · {state.done} / {state.total} paragraphs
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void uploadManager.resume(state.book.id)}
            aria-label="Resume synthesis"
            className="inline-flex items-center gap-1.5 border border-accent px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
          >
            <Play className="h-3.5 w-3.5" />
            Resume
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

  const cancelling = state.type === 'cancelling'
  const fraction =
    state.type === 'voiceDownload'
      ? state.fraction
      : state.type === 'encoding'
        ? (state.progress ?? 1)
        : state.type === 'cancelling'
          ? 1
          : state.total > 0
            ? state.done / state.total
            : 0

  // Optional second line: the paragraph currently (or last) being synthesized.
  // Populated via onParagraphStart → JobState.synthesizing.current. Hidden when
  // not in synth or when the location isn't yet known.
  const currentLine =
    state.type === 'synthesizing' && state.current
      ? `ch. ${state.current.chapterIndex + 1}${state.current.chapterTitle ? ` "${state.current.chapterTitle.slice(0, 30)}"` : ''}, ¶ ${state.current.paragraphInChapter}/${state.current.chapterTotal}`
      : null

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-2 border-b border-accent/40 bg-accent-soft px-4 py-3 text-accent sm:px-5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Spinner />
          <span className="truncate text-sm">
            {cancelling
              ? `Cancelling “${state.book.title}”…`
              : state.type === 'voiceDownload'
                ? 'Downloading voice…'
                : state.type === 'encoding'
                  ? 'Encoding audiobook…'
                  : state.mode === 'resynth'
                    ? `Updating audio for “${state.book.title}”… ${state.done} / ${state.total}`
                    : `Synthesizing “${state.book.title}”… ${state.done} / ${state.total}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(`/reader/${state.book.id}`)}
            className="inline-flex items-center gap-1.5 border border-accent px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Open
          </button>
          {state.type === 'synthesizing' && uploadManager.canPause() && (
            <button
              type="button"
              onClick={() => uploadManager.pause()}
              aria-label="Pause synthesis"
              className="inline-flex items-center gap-1.5 border border-accent px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          )}
          <button
            type="button"
            onClick={() => uploadManager.cancel()}
            disabled={cancelling}
            className="text-xs text-accent/70 transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-accent/70"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      </div>
      {currentLine && (
        <span className="text-xs text-accent/70" aria-hidden>
          {currentLine}
        </span>
      )}
      <ProgressBar fraction={fraction} />
    </div>
  )
}
