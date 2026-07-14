import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiKey } from '../../../lib/ai/keyring'
import { fetchModels, invalidateModels, type ModelInfo } from '../../../lib/ai/models'
import type { ProviderPreset } from '../../../lib/ai/providers'
import type { CloudProvider } from '../../../lib/ai/types'

function presetModelsToInfo(preset: ProviderPreset): ModelInfo[] {
  return (preset.models ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    free: m.free,
  }))
}

export type ModelState =
  | { type: 'loading' }
  | { type: 'ready'; models: ModelInfo[] }
  | { type: 'error'; message: string }
  | { type: 'manual' }

/**
 * Load the model list for a provider preset. Static presets (with a baked-in
 * `models` array) resolve immediately; presets that expose a `/models`
 * endpoint fetch on mount and whenever `baseUrl` changes. The fetch is
 * abortable so a rapid URL edit doesn't race a stale response in.
 *
 * Exposed `loadModels` lets the caller force a refresh after a key is saved.
 */
export function useProviderModels(
  preset: ProviderPreset,
  baseUrl: string,
  provider?: CloudProvider,
) {
  const [modelState, setModelState] = useState<ModelState>(() =>
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

  /** Force manual model entry (hides the dropdown until the user picks "from list"). */
  const setManual = useCallback(() => setModelState({ type: 'manual' }), [])

  return { modelState, loadModels, invalidate: invalidateModels, setManual }
}
