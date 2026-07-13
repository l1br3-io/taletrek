import { CloudLlmEngine } from './engines/openai'
import type { AiSettings, AiTransformEngine } from './types'

/**
 * Construct a fresh cloud AI transform engine selected by `Settings.ai`.
 *
 * Returns `null` when no provider is configured (no active provider, or active
 * provider not found). For most callers prefer {@link getAiEngine}, which caches
 * by config so the connection stays warm across navigations.
 */
export function createAiEngine(settings: AiSettings): AiTransformEngine | null {
  const providers = settings.cloud?.providers ?? []
  const provider = providers.find((p) => p.id === settings.cloud?.activeProviderId)
  if (!provider) return null
  return new CloudLlmEngine({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    model: provider.model,
  })
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
  return [provider?.baseUrl ?? '', provider?.model ?? ''].join('|')
}

/**
 * Cached engine by config. Returns the same instance across calls with the same
 * `Settings.ai`, so the cloud connection stays warm between library → reader →
 * library navigations. A config change (e.g. switching active provider) creates
 * a fresh engine.
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
