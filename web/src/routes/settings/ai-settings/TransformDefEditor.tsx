import { type FormEvent, useState } from 'react'
import type { CloudProvider, ParamSpec, TransformDefinition } from '../../../lib/ai/types'
import { newTransformDefId } from '../../../lib/ai/types'
import { PromptEditor, promptHtmlToPlain } from './PromptEditor'

interface TransformDefEditorProps {
  initial?: TransformDefinition
  providers?: CloudProvider[]
  onSave: (def: TransformDefinition) => void
  onCancel: () => void
}

export function TransformDefEditor({
  initial,
  providers,
  onSave,
  onCancel,
}: TransformDefEditorProps) {
  const [label, setLabel] = useState(initial?.label ?? '')
  const [hint, setHint] = useState(initial?.hint ?? '')
  const [desc, setDesc] = useState(initial?.desc ?? '')
  const [promptHtml, setPromptHtml] = useState(initial?.systemPrompt ?? '')
  const [params, setParams] = useState<ParamSpec[]>(initial?.params ?? [])
  const [useDefaultProvider, setUseDefaultProvider] = useState(!initial?.providerId)
  const [providerId, setProviderId] = useState(initial?.providerId ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!label.trim()) {
      setError('Label is required.')
      return
    }
    const systemPrompt = promptHtmlToPlain(promptHtml)
    if (!systemPrompt.trim()) {
      setError('System prompt is required.')
      return
    }
    const def: TransformDefinition = {
      id: initial?.id ?? newTransformDefId(),
      label: label.trim(),
      hint: hint.trim(),
      desc: desc.trim(),
      systemPrompt,
      params: params.filter((p) => p.key.trim()),
      ...(!useDefaultProvider && providerId ? { providerId } : {}),
      ...(useDefaultProvider ? {} : { providerId: providerId || undefined }),
      ...(!useDefaultProvider && model ? { model } : {}),
    }
    onSave(def)
  }

  const addParam = () => setParams((p) => [...p, { key: '', type: 'text', label: '', default: '' }])
  const removeParam = (idx: number) => setParams((p) => p.filter((_, i) => i !== idx))
  const updateParam = (idx: number, patch: Partial<ParamSpec>) =>
    setParams((p) => p.map((pp, i) => (i === idx ? { ...pp, ...patch } : pp)))

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <p className="rounded-md border border-danger/50 p-2 text-xs text-danger">{error}</p>
      )}

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Label</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          placeholder="e.g. Clean up OCR"
          className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Hint</span>
        <input
          type="text"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="One-line summary"
          className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Description</span>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={3}
          placeholder="Longer explanation shown in the transform picker"
          className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <div className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          System prompt
        </span>
        <PromptEditor value={promptHtml} onChange={setPromptHtml} params={params} />
        <p className="text-xs text-muted">
          The system prompt sent to the model. Use the buttons above to insert{' '}
          <code>{'{{key}}'}</code> references to declared parameters.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Parameters</span>
          <button type="button" onClick={addParam} className="text-xs text-accent hover:underline">
            + Add parameter
          </button>
        </div>
        {params.length === 0 && (
          <p className="text-xs text-muted">
            No parameters. Add one to let the user supply a value at runtime (e.g. target language).
          </p>
        )}
        {params.map((p, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: params are infrequently mutated form entries
          <div key={idx} className="flex items-start gap-2 rounded-lg border border-line p-3">
            <div className="grid flex-1 grid-cols-2 gap-2">
              <input
                type="text"
                value={p.key}
                onChange={(e) => updateParam(idx, { key: e.target.value })}
                placeholder="Key (e.g. target)"
                className="rounded border border-line bg-surface px-2 py-1 text-xs"
              />
              <select
                value={p.type}
                onChange={(e) => updateParam(idx, { type: e.target.value as ParamSpec['type'] })}
                className="rounded border border-line bg-surface px-2 py-1 text-xs"
              >
                <option value="text">Text</option>
                <option value="range">Range</option>
                <option value="select">Select</option>
              </select>
              <input
                type="text"
                value={String(p.default)}
                onChange={(e) => updateParam(idx, { default: e.target.value })}
                placeholder={`Default ${p.type}`}
                className="rounded border border-line bg-surface px-2 py-1 text-xs"
              />
              <input
                type="text"
                value={p.label}
                onChange={(e) => updateParam(idx, { label: e.target.value })}
                placeholder="Label"
                className="rounded border border-line bg-surface px-2 py-1 text-xs"
              />
            </div>
            <button
              type="button"
              onClick={() => removeParam(idx)}
              className="mt-1 text-xs text-danger hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {providers && providers.length > 0 && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">
            Provider override
          </span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useDefaultProvider}
              onChange={(e) => setUseDefaultProvider(e.target.checked)}
              className="accent-accent"
            />
            Use default provider
          </label>
          {!useDefaultProvider && (
            <div className="space-y-2">
              <select
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
              >
                <option value="">— Choose —</option>
                {providers.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.label ?? pr.presetId} ({pr.model})
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model override (optional)"
                className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
              />
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent hover:text-surface"
        >
          {initial ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}
