import { CloudLlmEngine } from './engines/openai'
import { WebLlmEngine } from './engines/webllm'
import type { AiSettings, AiTransformEngine } from './types'

/**
 * Construct a fresh AI transform engine selected by `Settings.ai`.
 *
 * Returns `null` when the cloud backend is selected but no provider is
 * configured (no active provider, or active provider not found).
 *
 * Cheap to call: `WebLlmEngine` does not spawn its worker or touch WebGPU until
 * `load()` is called. For most callers prefer {@link getAiEngine}, which caches
 * by config so the in-browser model stays resident across navigations.
 */
export function createAiEngine(settings: AiSettings): AiTransformEngine | null {
  if (settings.backend === 'cloud') {
    const providers = settings.cloud?.providers ?? []
    const provider = providers.find((p) => p.id === settings.cloud?.activeProviderId)
    if (!provider) return null
    return new CloudLlmEngine({
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      model: provider.model,
    })
  }
  return new WebLlmEngine({ modelId: settings.inBrowser.modelId })
}

interface Cached {
  key: string
  engine: AiTransformEngine
}
let cached: Cached | null = null

/** Cache key covering every field that changes the engine's identity. */
function engineKey(s: AiSettings): string {
  const providers = s.cloud?.providers ?? []
  const provider = providers.find((p) => p.id === s.cloud?.activeProviderId)
  return [s.backend, s.inBrowser.modelId, provider?.baseUrl ?? '', provider?.model ?? ''].join('|')
}

/**
 * Cached engine by config. Returns the same instance across calls with the same
 * `Settings.ai`, so the in-browser model stays loaded between
 * library → reader → library navigations (its 5-min idle teardown reclaims GPU
 * memory when truly idle). A config change (e.g. switching backend) creates a
 * fresh engine; the previous one's idle teardown cleans it up.
 */
export function getAiEngine(settings: AiSettings): AiTransformEngine | null {
  const key = engineKey(settings)
  if (cached?.key === key) return cached.engine
  const engine = createAiEngine(settings)
  if (!engine) return null
  cached = { key, engine }
  return engine
}

/** Test-only: drop the cached engine. */
export function _resetAiEngineForTests(): void {
  cached = null
}
