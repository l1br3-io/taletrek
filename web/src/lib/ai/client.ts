import { CloudLlmEngine } from './engines/openai'
import { WebLlmEngine } from './engines/webllm'
import type { AiSettings, AiTransformEngine } from './types'

/**
 * Construct a fresh AI transform engine selected by `Settings.ai`.
 *
 * Cheap to call: `WebLlmEngine` does not spawn its worker or touch WebGPU until
 * `load()` is called. For most callers prefer {@link getAiEngine}, which caches
 * by config so the in-browser model stays resident across navigations.
 */
export function createAiEngine(settings: AiSettings): AiTransformEngine {
  if (settings.backend === 'cloud') return new CloudLlmEngine(settings.cloud)
  return new WebLlmEngine({ modelId: settings.inBrowser.modelId })
}

interface Cached {
  key: string
  engine: AiTransformEngine
}
let cached: Cached | null = null

/** Cache key covering every field that changes the engine's identity. */
function engineKey(s: AiSettings): string {
  return [s.backend, s.inBrowser.modelId, s.cloud.baseUrl, s.cloud.model].join('|')
}

/**
 * Cached engine by config. Returns the same instance across calls with the same
 * `Settings.ai`, so the in-browser model stays loaded between
 * library → reader → library navigations (its 5-min idle teardown reclaims GPU
 * memory when truly idle). A config change (e.g. switching backend) creates a
 * fresh engine; the previous one's idle teardown cleans it up.
 */
export function getAiEngine(settings: AiSettings): AiTransformEngine {
  const key = engineKey(settings)
  if (cached?.key === key) return cached.engine
  const engine = createAiEngine(settings)
  cached = { key, engine }
  return engine
}

/** Test-only: drop the cached engine. */
export function _resetAiEngineForTests(): void {
  cached = null
}
