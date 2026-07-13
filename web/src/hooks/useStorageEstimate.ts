import { useCallback, useEffect, useState } from 'react'
import { getStorageEstimate } from '../lib/storage'

export interface StorageEstimateState {
  /** Bytes used by the origin (IDB + OPFS + Cache API + localStorage), or null. */
  usage: number | null
  /** Total quota granted by the browser, or null. */
  quota: number | null
  /** Re-query the estimate. Call after clearing data / caches. */
  refresh: () => Promise<void>
}

/**
 * Browser storage estimate via `navigator.storage.estimate()`. Covers the whole
 * origin — IndexedDB (books, chapters, settings, audio cache), OPFS (voice
 * models), and Cache API (app shell + Piper wasm). Powers the Settings
 * "Total app storage" indicator. Returns nulls when the API is unavailable
 * (private browsing on some browsers).
 */
export function useStorageEstimate(): StorageEstimateState {
  const [usage, setUsage] = useState<number | null>(null)
  const [quota, setQuota] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    const estimate = await getStorageEstimate()
    if (estimate) {
      setUsage(estimate.usage)
      setQuota(estimate.quota)
    } else {
      setUsage(null)
      setQuota(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { usage, quota, refresh }
}
