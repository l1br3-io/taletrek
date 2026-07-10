/**
 * Persistence helpers — ask the browser to exempt our storage from eviction.
 *
 * Safari/Chrome's `persist()` is granted/denied silently based on engagement,
 * never throws. We treat it as best-effort: the app must work whether or not
 * persistence is granted (see docs/prds/M0-foundation.md — "Safari 7-day ITP
 * eviction" risk).
 */

export function persistenceAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.persist
}

/** Request durable storage. Returns true if granted (or already persisted). */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  return navigator.storage.persist()
}

/** Whether storage has been granted persistence. */
export async function isPersisted(): Promise<boolean> {
  if (!navigator.storage?.persisted) return false
  return navigator.storage.persisted()
}

export interface StorageEstimate {
  usage: number
  quota: number
}

/** Current storage usage/quota in bytes, or null if unavailable. */
export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}
