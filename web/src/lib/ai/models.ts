/**
 * Model discovery via `GET {baseUrl}/models`.
 *
 * Fetches the list of available models from the provider's OpenAI-compatible
 * `/models` endpoint. For OpenRouter, parses the rich response to surface
 * context length, pricing, and free-model status. For other providers, returns
 * bare model ids.
 *
 * Results are cached in-memory per `baseUrl` for the tab's lifetime — model
 * lists change rarely and repeated fetches waste rate-limit budget.
 */

export interface ModelInfo {
  /** The model id to send in `chat/completions` body. */
  id: string
  /** Human-readable name if the provider supplies one. */
  name?: string
  /** Max context window in tokens, if known. */
  contextLength?: number
  /** Whether the model is free to use (pricing.prompt === "0" on OpenRouter). */
  free?: boolean
  /** Input price per token as a string (OpenRouter only). */
  promptPrice?: string
  /** Output price per token as a string (OpenRouter only). */
  completionPrice?: string
}

const cache = new Map<string, ModelInfo[]>()

/**
 * Fetch available models from a provider. Returns cached result if available.
 *
 * @param baseUrl  Provider base URL (e.g. `https://openrouter.ai/api/v1`)
 * @param apiKey   Optional — some providers (OpenAI, Together) require auth
 *                 even for listing; others (OpenRouter, Groq) are public.
 * @param signal   Optional abort signal.
 * @throws on network error, CORS failure, or non-200 response. Caller should
 *         fall back to a text input.
 */
export async function fetchModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const normalized = baseUrl.replace(/\/+$/, '')
  const cacheKey = normalized
  const cachedResult = cache.get(cacheKey)
  if (cachedResult) return cachedResult

  const url = `${normalized}/models`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await fetch(url, { headers, signal })
  if (!res.ok) {
    throw new Error(`Failed to list models: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as { data?: unknown[] }
  const data = Array.isArray(json.data) ? json.data : []

  const models = data.map((raw) => normalizeModel(raw, normalized))
  const sorted = models.sort((a, b) => {
    if (a.free && !b.free) return -1
    if (!a.free && b.free) return 1
    return a.id.localeCompare(b.id)
  })

  cache.set(cacheKey, sorted)
  return sorted
}

function normalizeModel(raw: unknown, baseUrl: string): ModelInfo {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) {
    return { id: String(raw) }
  }
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id : String(raw)

  const pricing = obj.pricing as { prompt?: unknown; completion?: unknown } | undefined
  if (pricing && typeof pricing.prompt === 'string') {
    const free = pricing.prompt === '0' && pricing.completion === '0'
    return {
      id,
      name: typeof obj.name === 'string' ? obj.name : undefined,
      contextLength: typeof obj.context_length === 'number' ? obj.context_length : undefined,
      free,
      promptPrice: pricing.prompt,
      completionPrice: typeof pricing.completion === 'string' ? pricing.completion : undefined,
    }
  }

  const isGroq = baseUrl.includes('api.groq.com')
  return {
    id,
    name: typeof obj.owned_by === 'string' ? obj.owned_by : undefined,
    free: isGroq,
  }
}

/** Drop the cache for a specific baseUrl (e.g. after the user edits the URL). */
export function invalidateModels(baseUrl: string): void {
  cache.delete(baseUrl.replace(/\/+$/, ''))
}

/** Test-only: clear the entire model cache. */
export function _resetModelCacheForTests(): void {
  cache.clear()
}
