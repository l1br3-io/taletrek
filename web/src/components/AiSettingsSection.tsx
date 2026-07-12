import { useState } from 'react'
import { clearApiKey, getApiKey, setApiKey } from '../lib/ai/keyring'
import type { AiSettings } from '../lib/ai/types'

interface AiSettingsSectionProps {
  ai: AiSettings
  onChange: (ai: AiSettings) => void
}

const BACKENDS = [
  {
    value: 'in-browser' as const,
    label: 'On-device',
    hint: 'WebGPU · offline · no key',
  },
  {
    value: 'cloud' as const,
    label: 'Cloud',
    hint: 'OpenAI-compatible · your key',
  },
]

/**
 * Presentational AI-transforms settings (M6). The `ai` config (enabled /
 * backend / model / cloud / modal) is props-driven and persists to IndexedDB.
 * The cloud API key is deliberately **not** a prop — it lives in-memory only
 * (`lib/ai/keyring`, ADR-0004), so its input + "Forget key" are self-contained
 * local state that never touches Settings.
 */
export function AiSettingsSection({ ai, onChange }: AiSettingsSectionProps) {
  const [hasKey, setHasKey] = useState(() => !!getApiKey())
  const [keyDraft, setKeyDraft] = useState('')

  const patch = (p: Partial<AiSettings>): void => {
    onChange({ ...ai, ...p })
  }

  const saveKey = (): void => {
    const trimmed = keyDraft.trim()
    if (!trimmed) return
    setApiKey(trimmed)
    setHasKey(true)
    setKeyDraft('')
  }
  const forgetKey = (): void => {
    clearApiKey()
    setHasKey(false)
    setKeyDraft('')
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">AI transforms</h2>
        <button
          type="button"
          onClick={() => patch({ enabled: !ai.enabled })}
          aria-pressed={ai.enabled}
          aria-label="Toggle AI transforms"
          className={[
            'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
            ai.enabled ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted',
          ].join(' ')}
        >
          {ai.enabled ? 'On' : 'Off'}
        </button>
      </div>
      <p className="text-xs text-muted">
        Optional: clean up OCR noise, translate, summarize, or simplify a book after upload.
        On-device by default (no key, works offline); or bring your own OpenAI-compatible cloud key
        for higher quality.
      </p>

      {ai.enabled && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {BACKENDS.map((b) => (
              <button
                key={b.value}
                type="button"
                onClick={() => patch({ backend: b.value })}
                aria-pressed={ai.backend === b.value}
                aria-label={`Use ${b.label} backend`}
                className={[
                  'rounded-lg border p-3 text-left transition-colors',
                  ai.backend === b.value
                    ? 'border-accent bg-elevated'
                    : 'border-line hover:border-muted',
                ].join(' ')}
              >
                <span className="block font-medium">{b.label}</span>
                <span className="block text-xs text-muted">{b.hint}</span>
              </button>
            ))}
          </div>

          {ai.backend === 'in-browser' ? (
            <label className="block space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Model</span>
              <input
                type="text"
                value={ai.inBrowser.modelId}
                onChange={(e) => patch({ inBrowser: { ...ai.inBrowser, modelId: e.target.value } })}
                aria-label="In-browser model id"
                className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-muted">
                Requires a WebGPU-capable browser. First use downloads the model (~1 GB) and caches
                it for offline reuse.
              </span>
            </label>
          ) : (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Base URL
                </span>
                <input
                  type="text"
                  value={ai.cloud.baseUrl}
                  onChange={(e) => patch({ cloud: { ...ai.cloud, baseUrl: e.target.value } })}
                  aria-label="Cloud base URL"
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-mono"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Model
                </span>
                <input
                  type="text"
                  value={ai.cloud.model}
                  onChange={(e) => patch({ cloud: { ...ai.cloud, model: e.target.value } })}
                  aria-label="Cloud model"
                  placeholder="gpt-4o-mini"
                  className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-mono"
                />
              </label>
              <div className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  API key
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveKey()
                    }}
                    aria-label="Cloud API key"
                    placeholder={hasKey ? '•••••• stored for this session' : 'paste key'}
                    className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={saveKey}
                    disabled={!keyDraft.trim()}
                    aria-label="Save API key"
                    className="rounded-md border border-line px-3 py-1.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={forgetKey}
                    disabled={!hasKey}
                    aria-label="Forget API key"
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-red-500 hover:text-red-400 disabled:opacity-50"
                  >
                    Forget
                  </button>
                </div>
                <span className="block text-xs text-muted">
                  {hasKey
                    ? 'Key held in memory for this tab only — not stored, cleared on close.'
                    : 'Never written to disk. Use a scoped, spend-capped key.'}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              When to offer transforms
            </span>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ai.modal.beforeUpload}
                onChange={(e) => patch({ modal: { ...ai.modal, beforeUpload: e.target.checked } })}
                className="accent-accent"
              />
              Before upload (pre-pick options)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ai.modal.afterUpload}
                onChange={(e) => patch({ modal: { ...ai.modal, afterUpload: e.target.checked } })}
                className="accent-accent"
              />
              After upload (default — pre-fill from pre-upload choices)
            </label>
          </div>
        </div>
      )}
    </section>
  )
}
