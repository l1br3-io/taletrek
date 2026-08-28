import { useCallback, useEffect, useState } from 'react'
import { useDatasource } from '../../context/datasource'
import { useOnline } from '../../hooks/useOnline'
import { ttsClient } from '../../lib/tts/client'
import { CURATED_VOICES } from '../../lib/tts/voices'
import type { VoiceId } from '../../types'
import { clearAllData } from './clearAllData'
import { useAudioCacheStats } from './useAudioCacheStats'
import { useStorageEstimate } from './useStorageEstimate'
import type { DownloadState } from './VoicePicker'

interface UseSettingsPageStateArgs {
  audioCacheBudgetMb: number
  setAudioCacheBudgetMb: (mb: number) => void
}

/**
 * Route-scoped state for the Settings page. Owns the ephemeral UI state
 * (voice download/remove, cache clearing, budget changes, delete-all flow)
 * so the page component stays a lean composition of sections.
 */
export function useSettingsPageState({
  audioCacheBudgetMb,
  setAudioCacheBudgetMb,
}: UseSettingsPageStateArgs) {
  const [storedIds, setStoredIds] = useState<ReadonlySet<string>>(new Set())
  const [downloading, setDownloading] = useState<DownloadState | null>(null)
  const [clearingCache, setClearingCache] = useState(false)
  const [booksCount, setBooksCount] = useState(0)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const { library } = useDatasource()
  const online = useOnline()
  const cacheStats = useAudioCacheStats()
  const storageEstimate = useStorageEstimate()

  // Refresh which voice models are already in OPFS.
  const refreshStored = useCallback(async () => {
    const results = await Promise.all(CURATED_VOICES.map((v) => ttsClient.isStored(v.id)))
    setStoredIds(new Set(CURATED_VOICES.filter((_, i) => results[i]).map((v) => v.id)))
  }, [])

  useEffect(() => {
    void refreshStored()
    void (async () => {
      const books = await library.getAllBooks()
      setBooksCount(books.length)
    })()
  }, [refreshStored, library])

  const handleDownload = useCallback(async (id: VoiceId) => {
    setDownloading({ id, progress: 0 })
    try {
      await ttsClient.download(id, (fraction) => setDownloading({ id, progress: fraction }))
      setStoredIds((prev) => new Set(prev).add(id))
    } finally {
      setDownloading(null)
    }
  }, [])

  const handleRemove = useCallback(async (id: VoiceId) => {
    await ttsClient.remove(id)
    setStoredIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const handleClearCache = useCallback(async () => {
    setClearingCache(true)
    try {
      await library.clearAudioCache()
      await library.clearSegmentCache()
      await cacheStats.refresh()
      await storageEstimate.refresh()
    } finally {
      setClearingCache(false)
    }
  }, [cacheStats, storageEstimate, library])

  const handleChangeBudget = useCallback(
    async (mb: number) => {
      const prevMb = audioCacheBudgetMb
      setAudioCacheBudgetMb(mb)
      if (mb < prevMb) {
        await library.evictAudioCacheToBudget(mb * 1024 * 1024)
        await cacheStats.refresh()
      }
    },
    [audioCacheBudgetMb, setAudioCacheBudgetMb, cacheStats, library],
  )

  const handleDeleteAllResult = useCallback(
    async (confirmed: boolean) => {
      if (!confirmed) {
        setDeleteDialogOpen(false)
        return
      }
      setDeletingAll(true)
      try {
        await clearAllData(library)
      } finally {
        // Reload to a fresh app state — the DB, OPFS, caches, and SW are gone.
        location.reload()
      }
    },
    [library],
  )

  return {
    storedIds,
    downloading,
    clearingCache,
    booksCount,
    deleteDialogOpen,
    deletingAll,
    online,
    cacheStats,
    storageEstimate,
    handleDownload,
    handleRemove,
    handleClearCache,
    handleChangeBudget,
    setDeleteDialogOpen,
    handleDeleteAllResult,
  }
}
