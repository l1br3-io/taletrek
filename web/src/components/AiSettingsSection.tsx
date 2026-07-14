import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  Pencil,
  Plug,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react'
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { type ConnectionTestResult, testConnection } from '../lib/ai/connection-test'
import { downloadKeyFile } from '../lib/ai/exportKey'
import { parseKeyFile } from '../lib/ai/importKey'
import { clearApiKey, getApiKey, setApiKey } from '../lib/ai/keyring'
import { fetchModels, invalidateModels, type ModelInfo } from '../lib/ai/models'
import { getPreset, PROVIDER_PRESETS, type ProviderPreset } from '../lib/ai/providers'
import type { AiSettings, CloudProvider } from '../lib/ai/types'
import { KeyExportConfirmDialog } from './KeyExportConfirmDialog'
import { KeySaveWarningDialog, shouldSkipKeySaveWarning } from './KeySaveWarningDialog'

interface AiSettingsSectionProps {
  ai: AiSettings
  onChange: (ai: AiSettings) => void
}

type CloudView =
  | { type: 'list' }
  | { type: 'add-preset' }
  | { type: 'add-config'; preset: ProviderPreset }
  | { type: 'edit'; provider: CloudProvider }

export function AiSettingsSection({ ai, onChange }: AiSettingsSectionProps) {
  const patch = (p: Partial<AiSettings>): void => {
    onChange({ ...ai, ...p })
  }

  return (
    <section className="space-y-5 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">AI transforms</h2>
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
        Optional: clean up OCR noise, translate, summarize, or simplify a book after upload. Bring
        your own OpenAI-compatible cloud key.
      </p>

      {ai.enabled && (
        <div className="space-y-4">
          <CloudProvidersSection
            providers={ai.cloud.providers}
            activeProviderId={ai.cloud.activeProviderId}
            onChange={(cloud) => patch({ cloud })}
          />
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Cloud providers list + add/edit flow
// ---------------------------------------------------------------------------

interface CloudProvidersSectionProps {
  providers: CloudProvider[]
  activeProviderId: string | null
  onChange: (cloud: AiSettings['cloud']) => void
}

function CloudProvidersSection({
  providers,
  activeProviderId,
  onChange,
}: CloudProvidersSectionProps) {
  const [view, setView] = useState<CloudView>({ type: 'list' })
  const [importErr, setImportErr] = useState<string | null>(null)
  const [showSchema, setShowSchema] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const patchCloud = (patch: Partial<AiSettings['cloud']>): void => {
    onChange({ providers, activeProviderId, ...patch })
  }

  const addProvider = (provider: CloudProvider): void => {
    patchCloud({
      providers: [...providers, provider],
      activeProviderId: provider.id,
    })
    setView({ type: 'list' })
  }

  const updateProvider = (updated: CloudProvider): void => {
    patchCloud({ providers: providers.map((p) => (p.id === updated.id ? updated : p)) })
    setView({ type: 'list' })
  }

  const removeProvider = (id: string): void => {
    clearApiKey(id)
    const remaining = providers.filter((p) => p.id !== id)
    patchCloud({
      providers: remaining,
      activeProviderId: activeProviderId === id ? (remaining[0]?.id ?? null) : activeProviderId,
    })
  }

  const setActive = (id: string): void => {
    patchCloud({ activeProviderId: id })
  }

  const importKey = (file: File): void => {
    setImportErr(null)
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      const result = parseKeyFile(text)
      if (!result.ok) {
        setImportErr(result.error)
        return
      }
      const presetId = result.provider ?? 'custom'
      const preset = getPreset(presetId)
      const provider: CloudProvider = {
        id: crypto.randomUUID(),
        presetId,
        baseUrl: result.baseUrl ?? preset.baseUrl,
        model: result.model ?? preset.defaultModel ?? '',
      }
      setApiKey(provider.id, result.apiKey)
      addProvider(provider)
    }
    reader.onerror = () => setImportErr('Could not read file.')
    reader.readAsText(file)
  }

  if (view.type === 'add-preset') {
    return (
      <div className="space-y-3">
        <PresetPicker
          onPick={(preset) => setView({ type: 'add-config', preset })}
          onCancel={() => setView({ type: 'list' })}
        />
      </div>
    )
  }

  if (view.type === 'add-config') {
    return (
      <ProviderConfigForm
        preset={view.preset}
        onSave={addProvider}
        onCancel={() => setView({ type: 'list' })}
      />
    )
  }

  if (view.type === 'edit') {
    return (
      <ProviderConfigForm
        preset={getPreset(view.provider.presetId)}
        provider={view.provider}
        onSave={updateProvider}
        onCancel={() => setView({ type: 'list' })}
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Cloud providers
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowSchema((s) => !s)}
            aria-expanded={showSchema}
            aria-label="Key file format"
            aria-pressed={showSchema}
            className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-accent"
          >
            <Info className="h-3.5 w-3.5" /> Format
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-muted transition-colors hover:text-accent"
          >
            Import key file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importKey(f)
              e.target.value = ''
            }}
          />
        </div>
      </div>

      {showSchema && <KeyFileSchemaInfo />}

      {importErr && (
        <span role="alert" className="block text-xs text-danger">
          {importErr}
        </span>
      )}

      {providers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-muted">
          No providers configured yet. Add one to get started.
        </p>
      ) : (
        <div className="space-y-2">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isActive={provider.id === activeProviderId}
              onSetActive={() => setActive(provider.id)}
              onEdit={() => setView({ type: 'edit', provider })}
              onRemove={() => removeProvider(provider.id)}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setView({ type: 'add-preset' })}
        className="w-full rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted transition-colors hover:border-accent hover:text-accent"
      >
        + Add provider
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Key file format help (import schema reference)
// ---------------------------------------------------------------------------

const KEY_FILE_EXAMPLE = `{
  "apiKey": "sk-…",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "baseUrl": "https://api.openai.com/v1"
}`

/** Inline reference for the import-file schema, shown when the user taps "Format". */
function KeyFileSchemaInfo() {
  const validIds = PROVIDER_PRESETS.map((p) => p.id).join(', ')
  return (
    <div className="space-y-2 rounded-lg border border-line bg-bg p-3 text-xs text-muted">
      <p className="text-fg">
        Import a <code className="font-mono">.json</code> file shaped like:
      </p>
      <pre className="overflow-x-auto rounded-md border border-line bg-surface p-2 font-mono text-[11px] leading-relaxed text-fg">
        {KEY_FILE_EXAMPLE}
      </pre>
      <ul className="space-y-0.5">
        <li>
          <code className="font-mono text-fg">apiKey</code> (string) — required; the rest are
          optional.
        </li>
        <li>
          <code className="font-mono text-fg">provider</code> — maps to one of: {validIds}. Unknown
          values fall back to <code className="font-mono">custom</code>.
        </li>
        <li>
          <code className="font-mono text-fg">model</code> /{' '}
          <code className="font-mono text-fg">baseUrl</code> — override the provider's defaults.
        </li>
      </ul>
      <p>
        The API key is held in memory for this tab only and is never written to disk by TaleTrek
        (ADR-0004). Export writes a <code className="font-mono">.json</code> file that round-trips
        on import — when a key is loaded it's included in the file (plaintext), so treat an exported
        file as a secret.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider card (compact view)
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  provider: CloudProvider
  isActive: boolean
  onSetActive: () => void
  onEdit: () => void
  onRemove: () => void
}

function ProviderCard({ provider, isActive, onSetActive, onEdit, onRemove }: ProviderCardProps) {
  const preset = getPreset(provider.presetId)
  const label = provider.label ?? preset.label
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const hasKey = !!getApiKey(provider.id)

  const handleExport = (): void => {
    // A key in memory will be written to the downloaded file — confirm first.
    if (hasKey) {
      setShowExport(true)
      return
    }
    downloadKeyFile(provider)
  }

  const statusEl: ReactNode = !hasKey ? (
    'Key: not set'
  ) : testing ? (
    'Testing…'
  ) : testResult?.type === 'success' ? (
    <>
      <CheckCircle2 className="h-3.5 w-3.5" /> Connected
    </>
  ) : testResult?.type === 'auth-error' ? (
    <>
      <XCircle className="h-3.5 w-3.5" /> Invalid key
    </>
  ) : testResult?.type === 'model-not-found' ? (
    <>
      <XCircle className="h-3.5 w-3.5" /> Model not found
    </>
  ) : testResult?.type === 'network' ? (
    <>
      <AlertTriangle className="h-3.5 w-3.5" />{' '}
      {preset.corsSafe ? 'Network error (retry)' : 'CORS / unreachable'}
    </>
  ) : testResult?.type === 'error' ? (
    <>
      <XCircle className="h-3.5 w-3.5" /> {testResult.status}
    </>
  ) : (
    'Key: ●●●●●● (untested)'
  )

  const handleTest = async (): Promise<void> => {
    const key = getApiKey(provider.id)
    if (!key) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testConnection(provider.baseUrl, key, provider.model)
      setTestResult(result)
    } catch {
      setTestResult({ type: 'network' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div
      className={[
        'rounded-lg border p-3 transition-colors',
        isActive ? 'border-accent bg-elevated' : 'border-line',
      ].join(' ')}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{label}</span>
            {isActive && (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">
                Active
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {provider.model || 'No model set'} · {provider.baseUrl || 'No URL'}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className={[
                'inline-flex items-center gap-1 text-xs',
                testResult?.type === 'success'
                  ? 'text-success'
                  : testResult
                    ? 'text-danger'
                    : 'text-muted',
              ].join(' ')}
            >
              {statusEl}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {!isActive && (
          <button
            type="button"
            onClick={onSetActive}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs font-medium transition-colors hover:border-accent hover:text-accent"
          >
            <Star className="h-3.5 w-3.5" /> Set active
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={!hasKey || testing}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {testing ? (
            'Testing…'
          ) : (
            <>
              <Plug className="h-3.5 w-3.5" /> Test
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        <button
          type="button"
          onClick={handleExport}
          aria-label={`Export ${label}`}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Download className="h-3.5 w-3.5" /> Export
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-danger hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </button>
      </div>

      <KeyExportConfirmDialog
        open={showExport}
        label={label}
        onConfirm={() => {
          setShowExport(false)
          downloadKeyFile(provider)
        }}
        onCancel={() => setShowExport(false)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preset picker (add flow step 1)
// ---------------------------------------------------------------------------

interface PresetPickerProps {
  onPick: (preset: ProviderPreset) => void
  onCancel: () => void
}

function PresetPicker({ onPick, onCancel }: PresetPickerProps) {
  return (
    <div className="space-y-3">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">
        Choose a provider
      </span>
      <div className="grid grid-cols-2 gap-2">
        {PROVIDER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-lg border border-line p-3 text-left transition-colors hover:border-accent"
          >
            <span className="block font-medium">{p.label}</span>
            <span className="block text-xs text-muted">{p.description}</span>
            <span className="mt-1 block text-xs">
              {p.corsSafe ? (
                <span className="inline-flex items-center gap-1 text-success">
                  CORS <CheckCircle2 className="h-3.5 w-3.5" />
                </span>
              ) : p.id === 'custom' ? (
                <span className="text-muted">Enter URL manually</span>
              ) : (
                <span className="text-warning">CORS unverified</span>
              )}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-muted transition-colors hover:text-fg"
      >
        Cancel
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider config form (add/edit)
// ---------------------------------------------------------------------------

interface ProviderConfigFormProps {
  preset: ProviderPreset
  provider?: CloudProvider
  onSave: (provider: CloudProvider) => void
  onCancel: () => void
}

type ModelState =
  | { type: 'loading' }
  | { type: 'ready'; models: ModelInfo[] }
  | { type: 'error'; message: string }
  | { type: 'manual' }

function ProviderConfigForm({ preset, provider, onSave, onCancel }: ProviderConfigFormProps) {
  const isEdit = !!provider
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? preset.baseUrl)
  const [model, setModel] = useState(provider?.model ?? preset.defaultModel ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [hasKey, setHasKey] = useState(() => (provider ? !!getApiKey(provider.id) : false))
  const [label, setLabel] = useState(provider?.label ?? '')
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [showKeyWarning, setShowKeyWarning] = useState(false)
  const [modelState, setModelState] = useState<ModelState>(
    preset.models
      ? { type: 'ready', models: presetModelsToInfo(preset) }
      : preset.supportsModelsEndpoint
        ? { type: 'loading' }
        : { type: 'manual' },
  )
  const abortRef = useRef<AbortController | null>(null)

  const loadModels = useCallback(
    async (url: string, key?: string): Promise<void> => {
      if (preset.models) {
        setModelState({ type: 'ready', models: presetModelsToInfo(preset) })
        return
      }
      if (!preset.supportsModelsEndpoint || !url) {
        setModelState({ type: 'manual' })
        return
      }
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setModelState({ type: 'loading' })
      try {
        const models = await fetchModels(url, key, ac.signal)
        if (!ac.signal.aborted) {
          setModelState({ type: 'ready', models })
        }
      } catch (err) {
        if (ac.signal.aborted) return
        const msg = err instanceof Error ? err.message : 'Failed to list models'
        setModelState({ type: 'error', message: msg })
      }
    },
    [preset],
  )

  useEffect(() => {
    void loadModels(baseUrl, provider ? getApiKey(provider.id) : undefined)
    return () => abortRef.current?.abort()
  }, [loadModels, baseUrl, provider])

  const handleSaveKey = (): void => {
    const trimmed = keyDraft.trim()
    if (!trimmed) return
    const id = provider?.id ?? 'draft'
    setApiKey(id, trimmed)
    setHasKey(true)
    setKeyDraft('')
    setTestResult(null)
    if (preset.supportsModelsEndpoint) {
      invalidateModels(baseUrl)
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
    const models = modelState.models as ModelInfo[]
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
              onClick={() => setModelState({ type: 'manual' })}
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a preset's static `models` list into the shape the picker expects. */
function presetModelsToInfo(preset: ProviderPreset): ModelInfo[] {
  return (preset.models ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    free: m.free,
  }))
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

function formatContextLength(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/**
 * Honest guidance for a `network` test result. A `fetch` TypeError is
 * indistinguishable between CORS, network failure, and a server error whose
 * body the browser hid — so the advice differs by whether the provider is
 * known CORS-safe. For CORS-safe providers the failure is almost always a
 * hidden rate-limit (429) or 5xx, not a real CORS issue.
 */
function networkGuidance(corsSafe: boolean): { label: string; detail: string } {
  return corsSafe
    ? {
        label: 'Network error — often rate-limited',
        detail:
          'The browser could not read the response. This usually means a rate limit (429) or server error whose body was blocked — check the browser Network tab or retry shortly.',
      }
    : {
        label: 'CORS / network error',
        detail:
          'The endpoint may not allow browser requests (missing CORS headers) or is unreachable. Use a CORS-safe provider or add a proxy.',
      }
}

function TestResultPill({
  result,
  corsSafe,
}: {
  result: ConnectionTestResult
  corsSafe: boolean
}): ReactElement {
  switch (result.type) {
    case 'success':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
        </span>
      )
    case 'auth-error':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
          <XCircle className="h-3.5 w-3.5" /> Invalid key
        </span>
      )
    case 'model-not-found':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
          <XCircle className="h-3.5 w-3.5" /> Model not found
        </span>
      )
    case 'network': {
      const g = networkGuidance(corsSafe)
      return (
        <span
          className="inline-flex items-center gap-1 text-xs font-medium text-warning"
          title={g.detail}
        >
          <AlertTriangle className="h-3.5 w-3.5" /> {g.label}
        </span>
      )
    }
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
          <XCircle className="h-3.5 w-3.5" /> {result.status}
        </span>
      )
  }
}
