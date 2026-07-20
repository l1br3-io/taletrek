import { BookOpen, Pause, Play, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useIsMobile } from '../hooks/useIsMobile'
import { uploadManager } from '../lib/upload/manager'
import { useUploadState } from '../lib/upload/useUpload'
import { canKeepScreenAwake } from '../lib/wake-lock'

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
 * Format a synth ETA for the global banner. Returns `null` when no estimate
 * is available yet (no sample) — callers fall back to "estimating…".
 */
function formatEta(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null
  const sec = Math.round(ms / 1000)
  if (sec < 30) return '<1 min left'
  if (sec < 60) return '~1 min left'
  const min = Math.round(sec / 60)
  if (min < 60) return `~${min} min left`
  const hr = Math.floor(min / 60)
  const rem = min % 60
  return rem === 0 ? `~${hr} hr left` : `~${hr} hr ${rem} min left`
}

/**
 * 1Hz re-render ticker so derived displays (ETA) tick down between
 * onProgress updates. Without this, "5 min left" would freeze until the
 * next paragraph completes — every few seconds — and never visibly count
 * down. No-op when `active` is false (no interval scheduled).
 */
function useSecondTicker(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])
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
  const isMobile = useIsMobile()
  const recovering = uploadManager.isRecovering()
  const wakeLockSupported = canKeepScreenAwake()
  // Hook order must be stable across renders — call unconditionally. The
  // ticker is a no-op (no interval scheduled) unless we're actively
  // synthesizing with an ETA sample, so the cost is one closure per render.
  const etaMsForTicker =
    state.type === 'synthesizing' && state.etaMs !== undefined ? state.etaMs : undefined
  useSecondTicker(etaMsForTicker !== undefined)

  if (state.type === 'idle') return null

  // Recovery (Issue 4): after a long hide (presumed phone lock), the manager
  // runs pause → resume to respawn workers and fast-forward through the M8
  // cache. Suppress the pausing/paused/synthesizing flash by rendering a
  // single stable "Resuming after lock…" banner while `recovering` is set.
  // The state can be in any of those sub-states during the round-trip.
  if (recovering && state.type !== 'error' && state.type !== 'done' && 'book' in state) {
    const fraction =
      'done' in state && 'total' in state && state.total > 0 ? state.done / state.total : 0
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col gap-2 border-b border-accent/40 bg-accent-soft px-4 py-3 text-accent sm:px-5"
      >
        <div className="flex items-center gap-3">
          <Spinner />
          <span className="truncate text-sm">Resuming “{state.book.title}” after lock…</span>
        </div>
        <ProgressBar fraction={fraction} />
      </div>
    )
  }

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
  const pausing = state.type === 'pausing'
  const etaMs = state.type === 'synthesizing' || state.type === 'pausing' ? state.etaMs : undefined
  const etaLabel = formatEta(etaMs)
  const fraction =
    state.type === 'voiceDownload'
      ? state.fraction
      : state.type === 'encoding'
        ? (state.progress ?? 1)
        : state.type === 'cancelling'
          ? 1
          : state.type === 'pausing'
            ? state.total > 0
              ? state.done / state.total
              : 0
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
              : pausing
                ? `Pausing “${state.book.title}”… ${state.done} / ${state.total}`
                : state.type === 'voiceDownload'
                  ? 'Downloading voice…'
                  : state.type === 'encoding'
                    ? 'Encoding audiobook…'
                    : state.mode === 'resynth'
                      ? `Updating audio for “${state.book.title}”… ${state.done} / ${state.total}`
                      : `Synthesizing “${state.book.title}”… ${state.done} / ${state.total}`}
          </span>
          {etaLabel && (
            <span className="shrink-0 text-xs text-accent/70" aria-live="polite">
              {etaLabel}
            </span>
          )}
          {state.type === 'synthesizing' && !etaLabel && state.done > 0 && (
            <span className="shrink-0 text-xs text-accent/50" aria-hidden>
              estimating…
            </span>
          )}
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
            disabled={cancelling || pausing}
            className="text-xs text-accent/70 transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-accent/70"
          >
            {cancelling ? 'Cancelling…' : pausing ? 'Pausing…' : 'Cancel'}
          </button>
        </div>
      </div>
      {currentLine && (
        <span className="text-xs text-accent/70" aria-hidden>
          {currentLine}
        </span>
      )}
      {state.type === 'synthesizing' && (
        <p className="text-xs text-accent/60">
          {!wakeLockSupported
            ? 'Your browser can’t keep the screen awake — synth pauses on lock and resumes when you return.'
            : isMobile
              ? 'Keep this tab open. Closing or locking your phone will pause synthesis.'
              : 'Keep this tab open. Closing it will pause synthesis.'}
        </p>
      )}
      <ProgressBar fraction={fraction} />
    </div>
  )
}
