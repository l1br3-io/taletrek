import { useCallback, useEffect, useState } from 'react'
import { useDatasource } from '../../context/datasource'
import { clearAllData } from './clearAllData'
import { useAudioCacheStats } from './useAudioCacheStats'
import { useStorageEstimate } from './useStorageEstimate'

interface UseSettingsPageStateArgs {
  audioCacheBudgetMb: number
  setAudioCacheBudgetMb: (mb: number) => void
}

/**
 * Route-scoped state for the Settings page. Owns the ephemeral UI state
 * (cache clearing, budget changes, delete-all flow) so the page component
 * stays a lean composition of sections.
 */
export function useSettingsPageState({
  audioCacheBudgetMb,
  setAudioCacheBudgetMb,
}: UseSettingsPageStateArgs) {
  const [clearingCache, setClearingCache] = useState(false)
  const [booksCount, setBooksCount] = useState(0)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const { library } = useDatasource()
  const cacheStats = useAudioCacheStats()
  const storageEstimate = useStorageEstimate()

  useEffect(() => {
    void (async () => {
      const books = await library.getAllBooks()
      setBooksCount(books.length)
    })()
  }, [library])

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
        // Reload to a fresh app state — the DB, caches, and SW are gone.
        location.reload()
      }
    },
    [library],
  )

  return {
    clearingCache,
    booksCount,
    deleteDialogOpen,
    deletingAll,
    cacheStats,
    storageEstimate,
    handleClearCache,
    handleChangeBudget,
    setDeleteDialogOpen,
    handleDeleteAllResult,
  }
}
