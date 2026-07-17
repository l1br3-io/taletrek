import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type {
  AiSettings,
  CloudProvider,
  TransformDefId,
  TransformDefinition,
} from '../../../lib/ai/types'
import { TemplateGallery } from './TemplateGallery'
import { TransformDefEditor } from './TransformDefEditor'

interface TransformDefListProps {
  ai: AiSettings
  onChange: (ai: AiSettings) => void
}

type View = { type: 'list' } | { type: 'gallery' } | { type: 'edit'; def?: TransformDefinition }

export function TransformDefList({ ai, onChange }: TransformDefListProps) {
  const [view, setView] = useState<View>({ type: 'list' })

  const providers = ai.cloud.providers as CloudProvider[] | undefined
  const defs = ai.transformDefs

  const patch = (td: TransformDefinition[]) => {
    onChange({ ...ai, transformDefs: td })
  }

  const handleSave = (def: TransformDefinition) => {
    const idx = defs.findIndex((d) => d.id === def.id)
    if (idx >= 0) {
      const next = [...defs]
      next[idx] = def
      patch(next)
    } else {
      patch([...defs, def])
    }
    setView({ type: 'list' })
  }

  const handleDelete = (id: TransformDefId) => {
    if (
      !window.confirm(
        'Delete this transform? Books that used it will no longer pre-fill their processing.',
      )
    )
      return
    patch(defs.filter((d) => d.id !== id))
  }

  if (view.type === 'gallery') {
    return (
      <TemplateGallery
        onPick={(def) => setView({ type: 'edit', def })}
        onBlank={() => setView({ type: 'edit' })}
      />
    )
  }

  if (view.type === 'edit') {
    return (
      <TransformDefEditor
        initial={view.def}
        providers={providers}
        onSave={handleSave}
        onCancel={() => setView({ type: 'list' })}
      />
    )
  }

  // List view
  return (
    <div className="space-y-3">
      {defs.length === 0 ? (
        <div className="rounded-lg border border-line p-4 text-center">
          <p className="text-sm font-medium text-muted">No transforms yet</p>
          <p className="mt-1 text-xs text-muted">
            Create one to clean up, translate, summarize, or rewrite book text before TTS.
          </p>
          <button
            type="button"
            onClick={() => setView({ type: 'gallery' })}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent hover:text-surface"
          >
            <Plus className="h-4 w-4" />
            Create transform
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              {defs.length} transform{defs.length !== 1 ? 's' : ''}
            </span>
            <button
              type="button"
              onClick={() => setView({ type: 'gallery' })}
              className="text-xs text-accent hover:underline"
            >
              + New
            </button>
          </div>
          <ul className="space-y-2">
            {defs.map((def) => (
              <li
                key={def.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-line p-3"
              >
                <div className="min-w-0">
                  <div className="font-medium text-sm">{def.label}</div>
                  {def.hint && <div className="text-xs text-muted">{def.hint}</div>}
                  <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted">
                    {def.params.map((p) => (
                      <span
                        key={p.key}
                        className="rounded bg-line px-1 py-0.5"
                      >{`{{${p.key}}}`}</span>
                    ))}
                    {def.providerId && (
                      <span className="rounded bg-line px-1 py-0.5">provider</span>
                    )}
                    {def.model && <span className="rounded bg-line px-1 py-0.5">{def.model}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => setView({ type: 'edit', def })}
                    className="rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(def.id)}
                    aria-label={`Delete ${def.label}`}
                    className="rounded border border-line p-1 text-xs text-muted hover:border-danger hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
