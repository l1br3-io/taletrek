/**
 * Cloud API key holder — **in-memory only**.
 *
 * Module-scoped `Map<providerId, string>`; never written to IndexedDB,
 * localStorage, sessionStorage, cookies, or OPFS. Dies on tab close. Survives
 * reloads within a tab. This is the strictest viable option per
 * `docs/adr/0004-api-key-threat-model.md` — the primary exfiltration defence is
 * the CSP `connect-src` allowlist (T2), not at-rest encryption.
 *
 * `keyring` is the only module permitted to hold keys. Engines receive the
 * value via {@link getApiKey} at request time, never as a module import.
 */

const keys = new Map<string, string>()

/** Set the session key for a provider. Overwrites any previous value. */
export function setApiKey(providerId: string, key: string): void {
  keys.set(providerId, key)
}

/** Read the session key for a provider, or `undefined` if none set. */
export function getApiKey(providerId: string): string | undefined {
  return keys.get(providerId)
}

/** Forget the key for a specific provider immediately. */
export function clearApiKey(providerId: string): void {
  keys.delete(providerId)
}

/** Forget all keys immediately (e.g. on sign-out). */
export function clearAllKeys(): void {
  keys.clear()
}

/** True if any provider has a key set. */
export function hasAnyKey(): boolean {
  return keys.size > 0
}

/**
 * Snapshot every `(providerId → key)` pair as a plain object. Used by
 * `secure-keyring.ts` (ADR-0007) to serialize the in-memory keyring for
 * encryption. Does **not** persist anything — it is a copy of the current
 * module state, identical in exposure to calling {@link getApiKey} for every
 * known id.
 */
export function snapshotKeys(): Record<string, string> {
  return Object.fromEntries(keys)
}
