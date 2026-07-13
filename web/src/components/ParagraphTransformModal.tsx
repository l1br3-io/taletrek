import { Eraser, FileText, GraduationCap, Languages, Replace, Sparkles, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TransformOp } from '../lib/ai/types'
import type { CaseMode, DeterministicOp } from '../lib/transforms/deterministic'

interface ParagraphTransformModalProps {
  open: boolean
  /** Current text of the targeted paragraph (post-clean, for preview). */
  preview: string
  /** Whether AI transforms are enabled in settings. */
  aiEnabled: boolean
  /** True while an AI transform is in flight. */
  aiBusy: boolean
  /** Last error from a transform attempt, or null. */
  error: string | null
  /** At least one prior transform can be undone. */
  canUndo: boolean
  onApplyAi: (op: TransformOp) => void
  onApplyDeterministic: (op: DeterministicOp) => void
  onUndo: () => void
  onClose: () => void
}

const CASE_MODES: { mode: CaseMode; label: string }[] = [
  { mode: 'upper', label: 'UPPER' },
  { mode: 'lower', label: 'lower' },
  { mode: 'title', label: 'Title' },
  { mode: 'sentence', label: 'Sentence' },
]

/**
 * Per-paragraph transform menu (M6 extension). Offers deterministic (non-AI)
 * adjustments — casing, whitespace/quote normalization, find-and-replace — and,
 * when AI is enabled, the AI transforms scoped to this one paragraph. Results
 * replace the paragraph in place; the container keeps an undo stack.
 */
export function ParagraphTransformModal({
  open,
  preview,
  aiEnabled,
  aiBusy,
  error,
  canUndo,
  onApplyAi,
  onApplyDeterministic,
  onUndo,
  onClose,
}: ParagraphTransformModalProps) {
  const [target, setTarget] = useState('es')
  const [ratio, setRatio] = useState(0.5)
  const [level, setLevel] = useState(2)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [ignoreCase, setIgnoreCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ptm-title"
    >
      <div className="w-full max-w-lg space-y-4 rounded-xl border border-line bg-surface p-5">
        <header className="space-y-1">
          <h2 id="ptm-title" className="text-base font-semibold">
            Transform paragraph
          </h2>
          <p className="line-clamp-2 text-xs text-muted" title={preview}>
            {preview}
          </p>
        </header>

        {error && (
          <p role="alert" className="rounded-md border border-red-500/50 p-2 text-xs text-red-400">
            {error}
          </p>
        )}

        {/* Non-AI adjustments */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Adjust text</h3>
          <div className="flex flex-wrap gap-2">
            {CASE_MODES.map((c) => (
              <button
                key={c.mode}
                type="button"
                onClick={() => onApplyDeterministic({ kind: 'case', mode: c.mode })}
                className="rounded-md border border-line px-2.5 py-1 text-sm transition-colors hover:border-accent hover:text-accent"
              >
                {c.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onApplyDeterministic({ kind: 'normalize' })}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm transition-colors hover:border-accent hover:text-accent"
            >
              <Eraser className="h-3.5 w-3.5" /> Normalize spaces &amp; quotes
            </button>
          </div>
          <div className="space-y-1 rounded-md border border-line p-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="find"
                aria-label="Find"
                className="w-28 rounded border border-line bg-surface px-2 py-1 text-sm"
              />
              <input
                type="text"
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                placeholder="replace"
                aria-label="Replace"
                className="w-28 rounded border border-line bg-surface px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={!find}
                onClick={() =>
                  onApplyDeterministic({
                    kind: 'findReplace',
                    find,
                    replace,
                    ignoreCase,
                    wholeWord,
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                <Replace className="h-3.5 w-3.5" /> Replace
              </button>
            </div>
            <label className="flex items-center gap-3 text-xs text-muted">
              <span>
                <input
                  type="checkbox"
                  checked={ignoreCase}
                  onChange={(e) => setIgnoreCase(e.target.checked)}
                  className="mr-1 accent-accent"
                />
                ignore case
              </span>
              <span>
                <input
                  type="checkbox"
                  checked={wholeWord}
                  onChange={(e) => setWholeWord(e.target.checked)}
                  className="mr-1 accent-accent"
                />
                whole word
              </span>
            </label>
          </div>
        </section>

        {/* AI transforms */}
        {aiEnabled && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              AI transform
            </h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={aiBusy}
                onClick={() => onApplyAi({ kind: 'cleanup' })}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-2.5 py-1 text-sm text-accent transition-colors hover:bg-accent hover:text-surface disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" /> Clean up
              </button>
              <button
                type="button"
                disabled={aiBusy}
                onClick={() => onApplyAi({ kind: 'summarize', ratio })}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-2.5 py-1 text-sm text-accent transition-colors hover:bg-accent hover:text-surface disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" /> Summarize
              </button>
              <button
                type="button"
                disabled={aiBusy}
                onClick={() => onApplyAi({ kind: 'simplify', level })}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-2.5 py-1 text-sm text-accent transition-colors hover:bg-accent hover:text-surface disabled:opacity-50"
              >
                <GraduationCap className="h-3.5 w-3.5" /> Simplify
              </button>
              <div className="flex items-center gap-1 text-xs text-muted">
                <label className="flex items-center gap-1">
                  lvl
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={level}
                    onChange={(e) => setLevel(Number(e.target.value))}
                    aria-label="Simplify reading level"
                    className="w-16 accent-accent"
                  />
                </label>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={aiBusy}
                onClick={() => onApplyAi({ kind: 'translate', target })}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-2.5 py-1 text-sm text-accent transition-colors hover:bg-accent hover:text-surface disabled:opacity-50"
              >
                <Languages className="h-3.5 w-3.5" /> Translate
              </button>
              <input
                type="text"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label="Target language code"
                placeholder="es"
                className="w-20 rounded border border-line bg-surface px-2 py-1 text-sm"
              />
              <label className="flex items-center gap-1 text-xs text-muted">
                summarize
                <input
                  type="range"
                  min={0.2}
                  max={0.8}
                  step={0.1}
                  value={ratio}
                  onChange={(e) => setRatio(Number(e.target.value))}
                  aria-label="Summarize to fraction of length"
                  className="w-20 accent-accent"
                />
              </label>
            </div>
          </section>
        )}

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            <Undo2 className="h-4 w-4" /> Undo
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
