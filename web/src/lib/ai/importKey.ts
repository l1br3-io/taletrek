/** Result of parsing a key file: either a usable config or an error message. */
export type KeyFileResult =
  | { ok: true; apiKey: string; baseUrl?: string; model?: string; provider?: string }
  | { ok: false; error: string }

/**
 * Parse an imported key file. Accepts **JSON only**, shaped as:
 *
 * ```
 * { "apiKey": "sk-…", "provider": "openai", "model": "gpt-4o-mini", "baseUrl": "https://api.openai.com/v1" }
 * ```
 *
 * - `apiKey` (string) is required.
 * - `provider` (string) maps to one of the ids in `PROVIDER_PRESETS` (`openrouter`,
 *   `groq`, `openai`, `together`, `zen`, `custom`); falls back to `custom` if
 *   absent or unrecognized.
 * - `model` and `baseUrl` are optional and override the preset defaults.
 *
 * The API key is read client-side only — never uploaded (ADR-0004). Non-JSON
 * input is rejected; the legacy plain-text "whole file is the key" form and the
 * legacy `presetId` field are no longer accepted.
 */
export function parseKeyFile(text: string): KeyFileResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'File is empty.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'File must be valid JSON.' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'JSON config must be an object with an "apiKey" string field.' }
  }

  const obj = parsed as {
    apiKey?: unknown
    baseUrl?: unknown
    model?: unknown
    provider?: unknown
  }
  const apiKey = obj.apiKey
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return { ok: false, error: 'JSON "apiKey" must be a non-empty string.' }
  }
  const baseUrl = typeof obj.baseUrl === 'string' && obj.baseUrl.trim() ? obj.baseUrl : undefined
  const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model : undefined
  const provider =
    typeof obj.provider === 'string' && obj.provider.trim() ? obj.provider.trim() : undefined
  return { ok: true, apiKey: apiKey.trim(), baseUrl, model, provider }
}
