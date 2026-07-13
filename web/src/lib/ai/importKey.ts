/** Result of parsing a key file: either a usable config or an error message. */
export type KeyFileResult =
  | { ok: true; apiKey: string; baseUrl?: string; model?: string }
  | { ok: false; error: string }

/**
 * Parse an imported key file. Accepts two shapes:
 *
 * 1. A JSON object with an `apiKey` string (and optional `baseUrl` / `model`):
 *    `{ "apiKey": "sk-…", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" }`
 * 2. A plain-text file whose entire (trimmed) contents are the key itself.
 *
 * JSON without a usable `apiKey` is rejected; a non-JSON document is treated as
 * a plain-text key. Read client-side only — never uploaded (ADR-0004).
 */
export function parseKeyFile(text: string): KeyFileResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'File is empty.' }

  let parsed: unknown
  let parsedOk = true
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsedOk = false
  }

  if (parsedOk) {
    if (parsed && typeof parsed === 'object' && 'apiKey' in parsed) {
      const obj = parsed as { apiKey?: unknown; baseUrl?: unknown; model?: unknown }
      const apiKey = obj.apiKey
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return { ok: false, error: 'JSON "apiKey" must be a non-empty string.' }
      }
      const baseUrl =
        typeof obj.baseUrl === 'string' && obj.baseUrl.trim() ? obj.baseUrl : undefined
      const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model : undefined
      return { ok: true, apiKey: apiKey.trim(), baseUrl, model }
    }
    return { ok: false, error: 'JSON config must include an "apiKey" string field.' }
  }

  return { ok: true, apiKey: trimmed }
}
