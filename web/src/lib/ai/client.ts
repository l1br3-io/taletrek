import { CloudLlmEngine } from './engines/openai'
import type { AiSettings, AiTransformEngine, TransformDefinition } from './types'

/** Safe fallback when no provider `contextLimit` is configured (32K tokens). */
const DEFAULT_CONTEXT_LIMIT = 32768

/**
 * Construct a cloud AI transform engine from a provider id, base URL, model,
 * and context window size.
 */
function createEngine(
  providerId: string,
  baseUrl: string,
  model: string,
  contextLimit: number,
): AiTransformEngine | null {
  if (!baseUrl || !model) return null
  return new CloudLlmEngine({ providerId, baseUrl, model, contextLimit })
}

interface Cached {
  key: string
  engine: AiTransformEngine
}
const engines = new Map<string, Cached>()

/** Cache key covering every field that changes the engine's identity. */
function engineKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`
}

function resolveProvider(settings: AiSettings, providerId: string) {
  return (settings.cloud?.providers ?? []).find((p) => p.id === providerId)
}

/**
 * Cached engine for the global active provider. Used for outline detection and
 * pronunciation hints (which are not def-driven).
 */
export function getAiEngine(settings: AiSettings): AiTransformEngine | null {
  const provider = settings.cloud?.activeProviderId
    ? resolveProvider(settings, settings.cloud.activeProviderId)
    : null
  if (!provider) return null
  const key = engineKey(provider.baseUrl, provider.model)
  const hit = engines.get(key)
  if (hit) return hit.engine
  const ctxLimit = provider.contextLimit ?? DEFAULT_CONTEXT_LIMIT
  const engine = createEngine(provider.id, provider.baseUrl, provider.model, ctxLimit)
  if (!engine) return null
  engines.set(key, { key, engine })
  return engine
}

/**
 * Cached engine for a specific transform definition. If the def overrides
 * `providerId` / `model`, uses those; otherwise falls back to the global
 * active provider. Multiple defs sharing the same `(baseUrl, model)` pair
 * reuse the same connection.
 *
 * Context limit is resolved from the provider config (not the def).
 */
export function getAiEngineForDef(
  settings: AiSettings,
  def: TransformDefinition,
): AiTransformEngine | null {
  const providerId = def.providerId ?? settings.cloud?.activeProviderId
  const provider = providerId ? resolveProvider(settings, providerId) : null
  const baseUrl = provider?.baseUrl ?? ''
  const model = def.model ?? provider?.model ?? ''
  if (!providerId || !baseUrl || !model) return null
  const key = engineKey(baseUrl, model)
  const hit = engines.get(key)
  if (hit) return hit.engine
  const ctxLimit = provider?.contextLimit ?? DEFAULT_CONTEXT_LIMIT
  const engine = createEngine(providerId, baseUrl, model, ctxLimit)
  if (!engine) return null
  engines.set(key, { key, engine })
  return engine
}

/** Test-only: drop the engine cache. */
export function _resetAiEngineForTests(): void {
  engines.clear()
}
