import { WifiOff } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { InfoDisclosure } from '../../components/InfoDisclosure'
import type { TransformDefinition, TransformOp } from '../../lib/ai/types'
import type { TransformState } from './useAiTransform'

interface UploadBookModalProps {
  open: boolean
  state: TransformState
  onCancel: () => void
  /**
   * Stream-apply the selected ops via `bookTransformManager` and navigate to
   * the reader to watch the generation (M13 / ADR-0012). The reader
   * subscribes to the manager on mount and shows the streaming block visual.
   */
  onGenerate: (ops: TransformOp[]) => void
  /** Available transform definitions (from Settings → AI → Transform options). */
  defs: TransformDefinition[]
  /** Pre-fill selection + params (e.g. from `Book.processing` for Reprocess). */
  initialOps?: TransformOp[]
  /** Whether the device has an internet connection (AI transforms are cloud-only). */
  online: boolean
}

/**
 * Presentational modal shown after upload (and on reprocess). Owns only the
 * selection + param form state; the transform `state` (idle/running/done/error)
 * and the transform pipeline are the caller's. On Generate, builds the ordered
 * {@link TransformOp} list (user-selected order) and hands it to `onGenerate`.
 *
 * When no transforms are defined, shows a friendly empty-state pointing to
 * Settings.
 */
export function UploadBookModal({
  open,
  state,
  onCancel,
  onGenerate,
  defs,
  initialOps,
  online,
}: UploadBookModalProps) {
  const preselected = useMemo(() => new Set((initialOps ?? []).map((o) => o.defId)), [initialOps])
  const preselectedParams = useMemo<Record<string, Record<string, string | number>>>(() => {
    const m: Record<string, Record<string, string | number>> = {}
    for (const op of initialOps ?? []) m[op.defId] = op.params
    return m
  }, [initialOps])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselected))
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string | number>>>(
    () => preselectedParams,
  )

  // Reset the form each time the modal opens (so a stale prior submission clears).
  useEffect(() => {
    if (!open) return
    setSelected(new Set(preselected))
    setParamValues(preselectedParams)
  }, [open, preselected, preselectedParams])

  // Escape cancels.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  const builtOps = useMemo<TransformOp[]>(() => {
    const ops: TransformOp[] = []
    for (const def of defs) {
      if (!selected.has(def.id)) continue
      ops.push({ defId: def.id, params: paramValues[def.id] ?? {} })
    }
    return ops
  }, [defs, selected, paramValues])

  if (!open) return null

  const running = state.type === 'running'
  const anySelected = builtOps.length > 0
  const interactive = state.type === 'idle' || state.type === 'error'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-book-title"
    >
      <div className="w-full max-w-md space-y-4 rounded-xl border border-line bg-surface p-5">
        <header className="space-y-1">
          <h2 id="upload-book-title" className="text-lg font-semibold">
            Transform book
          </h2>
          <p className="text-xs text-muted">
            Pick AI transforms to apply before playback. Your original file is kept — re-run anytime
            to revert. Skip to go straight to the reader.
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
              <p className="rounded-md border border-danger/50 p-2 text-xs text-danger">
                {state.message}
              </p>
            )}
            {!online && (
              <p className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600">
                <WifiOff className="h-3.5 w-3.5 shrink-0" /> AI transforms require an internet
                connection.
              </p>
            )}
            {defs.length === 0 ? (
              <div className="rounded-lg border border-line p-4 text-center">
                <p className="text-sm font-medium text-muted">No transforms configured</p>
                <p className="mt-1 text-xs text-muted">
                  Create transforms in Settings → AI → Transform options, then come back to apply
                  them.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {defs.map((def) => {
                  const checked = selected.has(def.id)
                  const vals = paramValues[def.id] ?? {}
                  return (
                    <li
                      key={def.id}
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
                            setSelected((s) => {
                              const next = new Set(s)
                              if (e.target.checked) next.add(def.id)
                              else next.delete(def.id)
                              return next
                            })
                          }
                          disabled={!interactive || !online}
                          className="mt-0.5 accent-accent"
                        />
                        <span>
                          <span className="font-medium">{def.label}</span>
                          <span className="ml-2 text-xs font-normal text-muted">{def.hint}</span>
                          <span className="mt-1 block text-xs text-muted">{def.desc}</span>
                        </span>
                      </label>
                      {checked &&
                        def.params.map((param) => {
                          const value = vals[param.key] ?? param.default
                          const onChange = (v: string | number) =>
                            setParamValues((pv) => ({
                              ...pv,
                              [def.id]: { ...(pv[def.id] ?? {}), [param.key]: v },
                            }))
                          return (
                            <div key={param.key} className="mt-2 ml-6">
                              {param.type === 'text' ? (
                                <input
                                  type="text"
                                  value={String(value)}
                                  onChange={(e) => onChange(e.target.value)}
                                  disabled={!interactive || !online}
                                  aria-label={param.label}
                                  placeholder={String(param.default)}
                                  className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-sm"
                                />
                              ) : param.type === 'range' ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    type="range"
                                    min={param.min ?? 0}
                                    max={param.max ?? 1}
                                    step={param.step ?? 0.1}
                                    value={Number(value)}
                                    onChange={(e) => onChange(Number(e.target.value))}
                                    disabled={!interactive || !online}
                                    aria-label={param.label}
                                    className="w-48 accent-accent"
                                  />
                                  <span className="text-xs text-muted">{value}</span>
                                </div>
                              ) : param.type === 'select' ? (
                                <select
                                  value={String(value)}
                                  onChange={(e) => onChange(e.target.value)}
                                  disabled={!interactive || !online}
                                  aria-label={param.label}
                                  className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
                                >
                                  {(param.options ?? []).map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                </select>
                              ) : null}
                            </div>
                          )
                        })}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {anySelected && (
          <div className="rounded-lg border border-line bg-elevated p-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-fg">Recommendations</span>
              <InfoDisclosure>
                Transforms are applied in the order you select them. For best results: place "clean
                up" transforms first (they remove noise that confuses later steps), then
                language/summarise/simplify transforms. Uses the configured cloud provider and model
                — each paragraph API call counts against your quota.
              </InfoDisclosure>
            </div>
            <div className="mt-2 space-y-1 text-xs text-muted">
              {builtOps.map((op, i) => {
                const def = defs.find((d) => d.id === op.defId)
                if (!def) return null
                return (
                  <div key={def.id}>
                    {i + 1}. <span className="font-medium text-fg">{def.label}</span>
                    <span className="ml-1">
                      — {def.desc.substring(0, 80)}
                      {def.desc.length > 80 ? '…' : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => onCancel()}
            aria-label={
              running ? 'Cancel transform' : state.type === 'done' ? 'Close' : 'Skip processing'
            }
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted"
          >
            {running ? 'Cancel' : state.type === 'done' ? 'Close' : 'Skip'}
          </button>
          {state.type !== 'done' && state.type !== 'running' && (
            <button
              type="button"
              onClick={() => onGenerate(builtOps)}
              disabled={!anySelected || !online}
              aria-label="Generate — stream the AI rewrite live into the reader"
              className="rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-accent-strong disabled:opacity-50"
              title="Stream the rewrite into the reader — pause/resume/abort anytime."
            >
              Generate
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
