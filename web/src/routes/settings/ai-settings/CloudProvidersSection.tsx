import { Info } from 'lucide-react'
import { useRef, useState } from 'react'
import { parseKeyFile } from '../../../lib/ai/importKey'
import { clearApiKey, setApiKey } from '../../../lib/ai/keyring'
import { getPreset, type ProviderPreset } from '../../../lib/ai/providers'
import type { AiSettings, CloudProvider } from '../../../lib/ai/types'
import { KeyFileSchemaInfo } from './KeyFileSchemaInfo'
import { PresetPicker } from './PresetPicker'
import { ProviderCard } from './ProviderCard'
import { ProviderConfigForm } from './ProviderConfigForm'

type CloudView =
  | { type: 'list' }
  | { type: 'add-preset' }
  | { type: 'add-config'; preset: ProviderPreset }
  | { type: 'edit'; provider: CloudProvider }

interface CloudProvidersSectionProps {
  providers: CloudProvider[]
  activeProviderId: string | null
  onChange: (cloud: AiSettings['cloud']) => void
}

export function CloudProvidersSection({
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

  const importKey = async (file: File): Promise<void> => {
    setImportErr(null)
    try {
      const text = await file.text()
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
    } catch {
      setImportErr('Could not read file.')
    }
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
              if (f) void importKey(f)
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
