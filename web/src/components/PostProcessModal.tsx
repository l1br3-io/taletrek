import { useEffect, useMemo, useState } from 'react'
import type { TransformState } from '../hooks/useAiTransform'
import type { TransformKind, TransformOp } from '../lib/ai/types'

interface PostProcessModalProps {
  open: boolean
  state: TransformState
  onCancel: () => void
  onProcess: (ops: TransformOp[]) => void
  /** Pre-fill selection + params (e.g. from `Book.processing` for Reprocess). */
  initialOps?: TransformOp[]
}

const OPS: { kind: TransformKind; label: string; hint: string; desc: string }[] = [
  {
    kind: 'cleanup',
    label: 'Clean up',
    hint: 'Fix OCR noise, page numbers, broken hyphenation',
    desc: 'Repairs scanned-book text before TTS — fixes OCR errors, drops page numbers and “Chapter N” headers, and rejoins soft-hyphenated line breaks.',
  },
  {
    kind: 'translate',
    label: 'Translate',
    hint: 'Translate into another language',
    desc: 'Renders the whole book in a target language. Use a BCP-47 code such as es, fr, or de.',
  },
  {
    kind: 'summarize',
    label: 'Summarize',
    hint: 'Condense to a shorter listen',
    desc: 'Condenses the narrative to a fraction of its length — a shorter listen with the main beats and order preserved.',
  },
  {
    kind: 'simplify',
    label: 'Simplify',
    hint: 'Rewrite at a simpler reading level',
    desc: 'Rewrites each paragraph at a chosen reading level (1 simplest, 5 hardest) for easier listening.',
  },
]

function seedSelection(initialOps: TransformOp[] | undefined): Record<TransformKind, boolean> {
  const sel: Record<TransformKind, boolean> = {
    cleanup: false,
    translate: false,
    summarize: false,
    simplify: false,
  }
  for (const op of initialOps ?? []) sel[op.kind] = true
  return sel
}

function seedParams(initialOps: TransformOp[] | undefined): {
  target: string
  ratio: number
  level: number
} {
  const params = { target: 'es', ratio: 0.5, level: 2 }
  for (const op of initialOps ?? []) {
    if (op.kind === 'translate') params.target = op.target
    else if (op.kind === 'summarize') params.ratio = op.ratio
    else if (op.kind === 'simplify') params.level = op.level
  }
  return params
}

/**
 * Presentational post-process modal (M6). Owns only the selection + param form
 * state; the transform `state` (idle/running/done/error) and the engine are the
 * caller's. On Process, builds the ordered {@link TransformOp} list (cleanup →
 * translate → summarize → simplify) and hands it to `onProcess`.
 */
export function PostProcessModal({
  open,
  state,
  onCancel,
  onProcess,
  initialOps,
}: PostProcessModalProps) {
  const [selected, setSelected] = useState<Record<TransformKind, boolean>>(() =>
    seedSelection(initialOps),
  )
  const [target, setTarget] = useState('es')
  const [ratio, setRatio] = useState(0.5)
  const [level, setLevel] = useState(2)

  // Reset the form each time the modal opens (so a stale prior submission clears).
  useEffect(() => {
    if (!open) return
    setSelected(seedSelection(initialOps))
    const p = seedParams(initialOps)
    setTarget(p.target)
    setRatio(p.ratio)
    setLevel(p.level)
  }, [open, initialOps])

  // Escape cancels.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  const builtOps = useMemo<TransformOp[]>(
    () => [
      ...(selected.cleanup ? [{ kind: 'cleanup' } as const] : []),
      ...(selected.translate ? [{ kind: 'translate', target } as const] : []),
      ...(selected.summarize ? [{ kind: 'summarize', ratio } as const] : []),
      ...(selected.simplify ? [{ kind: 'simplify', level } as const] : []),
    ],
    [selected, target, ratio, level],
  )

  if (!open) return null

  const running = state.type === 'running'
  const anySelected = builtOps.length > 0
  const interactive = state.type === 'idle' || state.type === 'error'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ppm-title"
    >
      <div className="w-full max-w-md space-y-4 rounded-xl border border-line bg-surface p-5">
        <header className="space-y-1">
          <h2 id="ppm-title" className="text-lg font-semibold">
            Process book
          </h2>
          <p className="text-xs text-muted">
            Pick one or more transforms to run on the book’s text before TTS. Your original file is
            kept — you can always re-parse it to revert. After processing, the book resumes at the
            start of its current chapter.
          </p>
        </header>

        {state.type === 'running' ? (
          <div className="space-y-2">
            <p className="text-sm text-muted" aria-live="polite">
              {state.stage}…
            </p>
            <div
              className="h-2 overflow-hidden rounded-full bg-line"
              role="progressbar"
              aria-valuenow={Math.round(state.fraction * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${Math.round(state.fraction * 100)}%` }}
              />
            </div>
          </div>
        ) : state.type === 'done' ? (
          <p className="rounded-md bg-accent-soft p-3 text-sm text-accent" aria-live="polite">
            {state.message}
          </p>
        ) : (
          <>
            {state.type === 'error' && (
              <p className="rounded-md border border-red-500/50 p-2 text-xs text-red-400">
                {state.message}
              </p>
            )}
            <ul className="space-y-2">
              {OPS.map((op) => {
                const checked = selected[op.kind]
                return (
                  <li
                    key={op.kind}
                    className={[
                      'rounded-lg border p-3 transition-colors',
                      checked ? 'border-accent bg-accent-soft/40' : 'border-line',
                    ].join(' ')}
                  >
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setSelected((s) => ({ ...s, [op.kind]: e.target.checked }))
                        }
                        disabled={!interactive}
                        className="mt-0.5 accent-accent"
                      />
                      <span>
                        <span className="font-medium">{op.label}</span>
                        <span className="ml-2 text-xs font-normal text-muted">{op.hint}</span>
                        <span className="mt-1 block text-xs text-muted">{op.desc}</span>
                      </span>
                    </label>
                    {checked && op.kind === 'translate' && (
                      <input
                        type="text"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                        disabled={!interactive}
                        aria-label="Target language code"
                        placeholder="es"
                        className="mt-2 ml-6 w-24 rounded-md border border-line bg-surface px-2 py-1 text-sm"
                      />
                    )}
                    {checked && op.kind === 'summarize' && (
                      <input
                        type="range"
                        min={0.2}
                        max={0.8}
                        step={0.1}
                        value={ratio}
                        onChange={(e) => setRatio(Number(e.target.value))}
                        disabled={!interactive}
                        aria-label="Summarize to fraction of length"
                        className="mt-2 ml-6 w-48 accent-accent"
                      />
                    )}
                    {checked && op.kind === 'simplify' && (
                      <input
                        type="range"
                        min={1}
                        max={5}
                        step={1}
                        value={level}
                        onChange={(e) => setLevel(Number(e.target.value))}
                        disabled={!interactive}
                        aria-label="Simplify reading level (1 simplest)"
                        className="mt-2 ml-6 w-48 accent-accent"
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            aria-label={running ? 'Cancel transform' : 'Close'}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted"
          >
            {running ? 'Cancel' : 'Close'}
          </button>
          {state.type !== 'done' && state.type !== 'running' && (
            <button
              type="button"
              onClick={() => onProcess(builtOps)}
              disabled={!anySelected}
              aria-label="Process book"
              className="rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-surface disabled:opacity-50"
            >
              Process
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
