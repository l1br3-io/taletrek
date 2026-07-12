/**
 * Cloud API key holder — **in-memory only**.
 *
 * Module-scoped variable; never written to IndexedDB, localStorage,
 * sessionStorage, cookies, or OPFS. Dies on tab close. Survives reloads within
 * a tab. This is the strictest viable option per
 * `docs/adr/0004-api-key-threat-model.md` — the primary exfiltration defence is
 * the CSP `connect-src` allowlist (T2), not at-rest encryption.
 *
 * `keyring` is the only module permitted to hold the key. Engines receive the
 * value via {@link getApiKey} at request time, never as a module import.
 */

let key: string | undefined

/** Set the session key. Overwrites any previous value. */
export function setApiKey(next: string): void {
  key = next
}

/** Read the session key, or `undefined` if none has been set / it was cleared. */
export function getApiKey(): string | undefined {
  return key
}

/** Forget the key immediately. */
export function clearApiKey(): void {
  key = undefined
}
