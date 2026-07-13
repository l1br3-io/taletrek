import { ArrowRight, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { HintsScanState } from '../hooks/usePronunciationHints'
import type { PronunciationCandidate } from '../lib/ai/types'
import type { PronunciationEntry } from '../lib/clean/types'

const HIGH_CONFIDENCE_THRESHOLD = 0.8

interface PronunciationReviewProps {
  open: boolean
  state: HintsScanState
  bookTitle: string | null
  /** Accepted + edited entries to merge into the global dictionary. */
  onAccept: (entries: PronunciationEntry[]) => void
  onClose: () => void
}

interface Row {
  accepted: boolean
  find: string
  replace: string
}

function seedRows(candidates: PronunciationCandidate[]): Record<string, Row> {
  const rows: Record<string, Row> = {}
  for (const c of candidates) rows[c.id] = { accepted: false, find: c.find, replace: c.replace }
  return rows
}

/**
 * Presentational pronunciation-review modal (M6 T8). Receives a variant
 * `HintsScanState` from the `usePronunciationHints` hook and owns only the
 * per-candidate selection + edit state. On Save, collapses accepted rows to
 * `PronunciationEntry[]` (dropping `confidence` + `category`) and hands them to
 * `onAccept`; the caller merges into `Settings.cleaning.pronunciation`.
 */
export function PronunciationReview({
  open,
  state,
  bookTitle,
  onAccept,
  onClose,
}: PronunciationReviewProps) {
  const candidates = state.type === 'ready' ? state.candidates : []
  const [rows, setRows] = useState<Record<string, Row>>({})

  // Seed editable rows whenever a fresh candidate batch arrives.
  useEffect(() => {
    if (state.type === 'ready') setRows(seedRows(state.candidates))
  }, [state])

  // Escape closes (resets to idle via the caller's onClose).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const ranked = useMemo(
    () => [...candidates].sort((a, b) => b.confidence - a.confidence),
    [candidates],
  )

  const acceptedCount = useMemo(() => Object.values(rows).filter((r) => r.accepted).length, [rows])

  if (!open) return null

  const toggleRow = (id: string): void =>
    setRows((prev) => {
      const row = prev[id]
      return row ? { ...prev, [id]: { ...row, accepted: !row.accepted } } : prev
    })

  const editRow = (id: string, patch: Partial<Row>): void =>
    setRows((prev) => {
      const row = prev[id]
      return row ? { ...prev, [id]: { ...row, ...patch } } : prev
    })

  const acceptHighConfidence = (): void =>
    setRows((prev) => {
      const next = { ...prev }
      for (const c of ranked) {
        const existing = next[c.id]
        if (c.confidence >= HIGH_CONFIDENCE_THRESHOLD && existing) {
          next[c.id] = { ...existing, accepted: true }
        }
      }
      return next
    })

  const save = (): void => {
    const entries: PronunciationEntry[] = []
    for (const c of ranked) {
      const row = rows[c.id]
      if (row?.accepted && row.find.trim()) {
        entries.push({ id: c.id, find: row.find.trim(), replace: row.replace.trim() })
      }
    }
    onAccept(entries)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pr-title"
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col space-y-4 rounded-xl border border-line bg-surface p-5">
        <h2 id="pr-title" className="text-lg font-semibold">
          Pronunciation review{bookTitle ? ` — ${bookTitle}` : ''}
        </h2>

        {state.type === 'loading' && (
          <p className="text-sm text-muted">Scanning opening chapter…</p>
        )}

        {state.type === 'error' && (
          <p className="rounded-md border border-red-500/50 p-2 text-xs text-red-400">
            {state.message}
          </p>
        )}

        {state.type === 'ready' && (
          <>
            <p className="text-xs text-muted">
              The narrator suggested these replacements. Accept the ones you want — they take effect
              everywhere in the book (case-insensitive, whole word).
            </p>
            {ranked.length === 0 ? (
              <p className="rounded-md bg-elevated p-3 text-sm text-muted">
                No candidates found — the narrator already handles this book's names well.
              </p>
            ) : (
              <>
                <button
                  type="button"
                  onClick={acceptHighConfidence}
                  className="inline-flex items-center gap-1.5 self-start rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-surface"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Accept high-confidence (≥{Math.round(HIGH_CONFIDENCE_THRESHOLD * 100)}%)
                </button>
                <ul className="flex-1 space-y-2 overflow-y-auto">
                  {ranked.map((c) => {
                    const row = rows[c.id]
                    if (!row) return null
                    return (
                      <li key={c.id} className="space-y-1">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={row.accepted}
                            onChange={() => toggleRow(c.id)}
                            className="accent-accent"
                            aria-label={`Accept ${c.find}`}
                          />
                          <input
                            type="text"
                            value={row.find}
                            onChange={(e) => editRow(c.id, { find: e.target.value })}
                            aria-label="word to replace"
                            className="w-1/3 rounded-md border border-line bg-surface px-2 py-1 text-sm"
                          />
                          <ArrowRight className="h-4 w-4 shrink-0 text-muted" />
                          <input
                            type="text"
                            value={row.replace}
                            onChange={(e) => editRow(c.id, { replace: e.target.value })}
                            aria-label="replacement"
                            className="flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
                          />
                          <span
                            className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-xs text-muted"
                            title={`${c.category} · confidence ${Math.round(c.confidence * 100)}%`}
                          >
                            {Math.round(c.confidence * 100)}%
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted"
          >
            Close
          </button>
          {state.type === 'ready' && acceptedCount > 0 && (
            <button
              type="button"
              onClick={save}
              className="rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-surface"
            >
              Save {acceptedCount} accepted
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
