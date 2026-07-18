import { X } from 'lucide-react'
import { useEffect } from 'react'
import type { BookFormat } from '../../types'
import type { OutlineState } from './useOutline'

interface OutlineSheetProps {
  open: boolean
  state: OutlineState
  format: BookFormat
  online: boolean
  /** M10: apply the PDF's embedded outline (pdfjs `getOutline`). PDFs only. */
  onUsePdfOutline?: () => void
  onDetectAi?: () => void
  onClose: () => void
}

export function OutlineSheet({
  open,
  state,
  format,
  online,
  onUsePdfOutline,
  onDetectAi,
  onClose,
}: OutlineSheetProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const running = state.type === 'running'
  const isPdf = format === 'pdf'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="outline-sheet-title"
    >
      <div className="w-full max-w-md space-y-4 rounded-xl border border-line bg-surface p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 id="outline-sheet-title" className="text-lg font-semibold">
              {isPdf ? 'Re-process outline' : 'Detect chapters'}
            </h2>
            {isPdf ? (
              <p className="mt-0.5 text-xs text-muted">
                Re-segment this PDF: use the embedded outline (most accurate when present), or AI.
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-muted">
                Split the book into chapters using AI. The pre-M10 heuristic detector was removed —
                see ADR-0008.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted hover:text-fg"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {state.type === 'running' ? (
          <p className="text-sm text-muted" aria-live="polite">
            Working…
          </p>
        ) : state.type === 'done' ? (
          <p className="rounded-md bg-accent-soft p-3 text-sm text-accent" aria-live="polite">
            {state.message}
          </p>
        ) : state.type === 'error' ? (
          <p
            className="rounded-md border border-danger/50 p-2 text-xs text-danger"
            aria-live="polite"
          >
            {state.message}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          {running ? (
            <p className="flex-1 text-sm text-muted">Working…</p>
          ) : state.type === 'done' ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-muted"
            >
              Close
            </button>
          ) : (
            <>
              {isPdf && onUsePdfOutline && (
                <button
                  type="button"
                  onClick={onUsePdfOutline}
                  disabled={running}
                  aria-label="Use the PDF's embedded outline"
                  className="rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-surface disabled:opacity-50"
                >
                  Use PDF outline
                </button>
              )}
              {onDetectAi && (
                <button
                  type="button"
                  onClick={onDetectAi}
                  disabled={running || !online}
                  aria-label="Detect chapters with AI"
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted disabled:opacity-50"
                >
                  {online ? 'Use AI' : 'No connection'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
