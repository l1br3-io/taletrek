import { useCallback, useEffect, useState } from 'react'
import { useDatasource } from '../../context/datasource'

export interface AudioCacheStats {
  /** Current cache size in bytes, or null while loading / on error. */
  sizeBytes: number | null
  /** Re-query the cache size. Call after a Clear to refresh the indicator. */
  refresh: () => Promise<void>
}

/**
 * Read the total audio-cache size from IndexedDB (M8). Powers the Settings
 * "Storage" indicator. No polling interval — the cache only grows during
 * playback, not while Settings is open; call `refresh()` after a Clear.
 */
export function useAudioCacheStats(): AudioCacheStats {
  const { library } = useDatasource()
  const [sizeBytes, setSizeBytes] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSizeBytes(await library.getAudioCacheSize())
    } catch {
      setSizeBytes(null)
    }
  }, [library])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { sizeBytes, refresh }
}
