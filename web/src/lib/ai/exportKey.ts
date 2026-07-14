import { getApiKey } from './keyring'
import type { CloudProvider } from './types'

/**
 * The shape of an exported key file. When an API key is loaded in memory for
 * this provider it is included verbatim so the file round-trips fully on import
 * (handy for moving a setup between devices). The file is therefore a **secret** —
 * treat it like the key itself.
 *
 * Keys are still never *persisted by TaleTrek* (ADR-0004): nothing is written to
 * IndexedDB/localStorage. This export is an explicit user action that writes the
 * key to a file they own in their downloads folder.
 */
export interface KeyFileObject {
  apiKey?: string
  provider: string
  model: string
  baseUrl: string
  label?: string
}

/**
 * Build the JSON-serializable provider object. Pure + testable. `apiKey` is
 * included only when a non-empty value is passed (the caller reads it from the
 * in-memory keyring at export time).
 */
export function buildKeyFileObject(provider: CloudProvider, apiKey?: string): KeyFileObject {
  const obj: KeyFileObject = {
    provider: provider.presetId,
    model: provider.model,
    baseUrl: provider.baseUrl,
  }
  if (provider.label) obj.label = provider.label
  if (apiKey?.trim()) obj.apiKey = apiKey.trim()
  return obj
}

/** Filename (without extension) for an exported key file. */
export function keyFileName(provider: CloudProvider): string {
  const base = (provider.label ?? provider.presetId).trim().toLowerCase()
  const slug = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider'
  return `${slug}.json`
}

/**
 * Serialize a provider to a pretty JSON string, including the API key when one
 * is loaded in memory for this provider. Triggers a browser download when
 * running in the DOM; a safe no-op for the click when `document` is absent
 * (e.g. jsdom unit tests that only assert the serialized string). Returns the
 * JSON so callers/tests can inspect it.
 */
export function downloadKeyFile(provider: CloudProvider): string {
  const json = `${JSON.stringify(buildKeyFileObject(provider, getApiKey(provider.id)), null, 2)}\n`
  if (typeof document !== 'undefined') {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = keyFileName(provider)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
  return json
}
