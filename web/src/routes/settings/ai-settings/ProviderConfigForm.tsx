import { AlertTriangle, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { type ConnectionTestResult, testConnection } from '../../../lib/ai/connection-test'
import { clearApiKey, getApiKey, setApiKey } from '../../../lib/ai/keyring'
import type { ModelInfo } from '../../../lib/ai/models'
import type { ProviderPreset } from '../../../lib/ai/providers'
import type { CloudProvider } from '../../../lib/ai/types'
import { KeySaveWarningDialog, shouldSkipKeySaveWarning } from '../KeySaveWarningDialog'
import { TestResultPill } from './TestResultPill'
import { useProviderModels } from './useProviderModels'

function formatContextLength(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

function formatModelLabel(m: ModelInfo): string {
  const parts: string[] = [m.name ?? m.id]
  if (m.free) {
    parts.push('Free')
  } else if (m.promptPrice && m.promptPrice !== '0') {
    parts.push(`$${m.promptPrice}/tok in`)
  }
  if (m.contextLength) {
    parts.push(`${formatContextLength(m.contextLength)} ctx`)
  }
  return parts.join(' · ')
}

interface ProviderConfigFormProps {
  preset: ProviderPreset
  provider?: CloudProvider
  onSave: (provider: CloudProvider) => void
  onCancel: () => void
}

export function ProviderConfigForm({
  preset,
  provider,
  onSave,
  onCancel,
}: ProviderConfigFormProps) {
  const isEdit = !!provider
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? preset.baseUrl)
  const [model, setModel] = useState(provider?.model ?? preset.defaultModel ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [hasKey, setHasKey] = useState(() => (provider ? !!getApiKey(provider.id) : false))
  const [label, setLabel] = useState(provider?.label ?? '')
  const [contextLimit, setContextLimit] = useState(
    provider?.contextLimit ?? preset.defaultContextLimit ?? 32768,
  )
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [showKeyWarning, setShowKeyWarning] = useState(false)

  const { modelState, loadModels, invalidate, setManual } = useProviderModels(
    preset,
    baseUrl,
    provider,
  )

  const handleSaveKey = (): void => {
    const trimmed = keyDraft.trim()
    if (!trimmed) return
    const id = provider?.id ?? 'draft'
    setApiKey(id, trimmed)
    setHasKey(true)
    setKeyDraft('')
    setTestResult(null)
    if (preset.supportsModelsEndpoint) {
      invalidate(baseUrl)
      void loadModels(baseUrl, trimmed)
    }
  }

  const handleForgetKey = (): void => {
    const id = provider?.id ?? 'draft'
    clearApiKey(id)
    setHasKey(false)
    setKeyDraft('')
    setTestResult(null)
  }

  const handleTest = async (): Promise<void> => {
    const id = provider?.id ?? 'draft'
    const key = getApiKey(id)
    if (!key || !baseUrl || !model) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testConnection(baseUrl, key, model)
      setTestResult(result)
    } catch {
      setTestResult({ type: 'network' })
    } finally {
      setTesting(false)
    }
  }

  const performSave = (): void => {
    const id = provider?.id ?? crypto.randomUUID()
    if (provider && id !== provider.id) {
      // key was stored under draft id — re-key it
      const draftKey = getApiKey('draft')
      if (draftKey) {
        clearApiKey('draft')
        setApiKey(id, draftKey)
      }
    } else if (!provider) {
      const draftKey = getApiKey('draft')
      if (draftKey) {
        clearApiKey('draft')
        setApiKey(id, draftKey)
      }
    }
    const saved: CloudProvider = {
      id,
      presetId: preset.id,
      baseUrl,
      model,
      label: label.trim() || undefined,
      contextLimit,
    }
    onSave(saved)
  }

  const handleSave = (): void => {
    // ADR-0004 reminder: a key in memory is not written to disk. Only show the
    // warning when a key is actually loaded and the user hasn't silenced it.
    const id = provider?.id ?? 'draft'
    if (getApiKey(id) && !shouldSkipKeySaveWarning()) {
      setShowKeyWarning(true)
      return
    }
    performSave()
  }

  const handleWarningConfirm = (): void => {
    setShowKeyWarning(false)
    performSave()
  }

  const selectedModelInfo = (() => {
    if (modelState.type !== 'ready') return undefined
    return modelState.models.find((m) => m.id === model)
  })()

  const isFreeModel = selectedModelInfo?.free === true

  const visibleModels = (() => {
    if (modelState.type !== 'ready') return []
    const models = modelState.models
    const hasFree = models.some((m) => m.free)
    return hasFree ? models.filter((m) => m.free) : models
  })()

  const hiddenCount =
    modelState.type === 'ready' ? modelState.models.length - visibleModels.length : 0

  return (
    <div className="space-y-4 rounded-lg border border-line bg-bg p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg">
          {isEdit ? `Edit ${preset.label}` : `Configure ${preset.label}`}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-muted transition-colors hover:text-fg"
        >
          Cancel
        </button>
      </div>

      {preset.id === 'custom' && (
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Base URL</span>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            aria-label="Provider base URL"
            placeholder="https://api.example.com/v1"
            className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-mono"
          />
        </label>
      )}

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Label (optional)
        </span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="Provider label"
          placeholder={preset.label}
          className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <div className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">API key</span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveKey()
            }}
            aria-label="Cloud API key"
            placeholder={hasKey ? '•••••• stored for this session' : 'paste key'}
            className="min-w-[12rem] flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={handleSaveKey}
            disabled={!keyDraft.trim()}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            Save key
          </button>
          {hasKey && (
            <button
              type="button"
              onClick={handleForgetKey}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-danger hover:text-danger"
            >
              Forget
            </button>
          )}
        </div>
        {preset.signupUrl && (
          <a
            href={preset.signupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            Get a key at {preset.signupUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <span className="block text-xs text-muted">{preset.keyScopeHint}</span>
        <span className="block text-xs text-muted">
          Key held in memory for this tab only — not stored, cleared on close. Malicious browser
          extensions can still read it.
        </span>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Model</span>
          {modelState.type === 'ready' && (
            <button
              type="button"
              onClick={setManual}
              className="text-xs text-muted transition-colors hover:text-fg"
            >
              Type manually
            </button>
          )}
          {modelState.type === 'manual' && (preset.supportsModelsEndpoint || preset.models) && (
            <button
              type="button"
              onClick={() => void loadModels(baseUrl, getApiKey(provider?.id ?? 'draft'))}
              className="text-xs text-muted transition-colors hover:text-fg"
            >
              Pick from list
            </button>
          )}
        </div>
        {modelState.type === 'loading' && <p className="text-xs text-muted">Loading models…</p>}
        {modelState.type === 'error' && (
          <div className="space-y-1">
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="Cloud model"
              placeholder={preset.defaultModel ?? 'model-id'}
              className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-mono"
            />
            <p className="text-xs text-muted">Couldn't list models — enter the id manually.</p>
          </div>
        )}
        {modelState.type === 'ready' && (
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              setTestResult(null)
            }}
            aria-label="Cloud model"
            className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
          >
            {!visibleModels.some((m) => m.id === model) && model && (
              <option value={model}>{model} (current)</option>
            )}
            {visibleModels.map((m) => (
              <option key={m.id} value={m.id}>
                {formatModelLabel(m)}
              </option>
            ))}
          </select>
        )}
        {hiddenCount > 0 && (
          <p className="text-xs text-muted">
            Showing {visibleModels.length} free models ({hiddenCount} paid hidden).
          </p>
        )}
        {modelState.type === 'manual' && (
          <input
            type="text"
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              setTestResult(null)
            }}
            aria-label="Cloud model"
            placeholder={preset.defaultModel ?? 'model-id'}
            className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-mono"
          />
        )}
        {isFreeModel && (
          <span className="inline-block rounded bg-success/15 px-1.5 py-0.5 text-xs font-medium text-success">
            Free
          </span>
        )}
      </div>

      {isFreeModel && (
        <p className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Free models may use submitted text for training. Avoid sending content you wouldn't
            share publicly. Use a paid model for sensitive books.
          </span>
        </p>
      )}

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Context window (tokens)
        </span>
        <input
          type="number"
          value={contextLimit}
          onChange={(e) => setContextLimit(Number(e.target.value))}
          aria-label="Context window size in tokens"
          className="w-48 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-mono"
        />
        <p className="text-xs text-muted">
          Used to compute how many paragraphs fit in one API call. Auto-filled from the preset;
          increase if your model has a larger window.
        </p>
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={!hasKey || !baseUrl || !model || testing}
          className="rounded-md border border-line px-3 py-1.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {testResult && <TestResultPill result={testResult} corsSafe={preset.corsSafe} />}
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line px-4 py-1.5 text-sm text-muted transition-colors hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!baseUrl || !model}
          className="rounded-md border border-accent bg-accent-soft px-4 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
        >
          Save provider
        </button>
      </div>

      <KeySaveWarningDialog
        open={showKeyWarning}
        onConfirm={() => handleWarningConfirm()}
        onCancel={() => setShowKeyWarning(false)}
      />
    </div>
  )
}
