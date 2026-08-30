import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useDatasource } from '../../context/datasource'
import type { Book, BookId } from '../../types'

type ListState =
  | { type: 'loading' }
  | { type: 'ready'; books: Book[] }
  | { type: 'error'; message: string }

/**
 * Route-scoped state for the Library page: the book list plus the
 * rename/delete/export actions. Books enter the library via `.taletrek`
 * bundle import (ADR-0015 — the upload/parse/synth pipeline is gone).
 */
export function useLibraryState() {
  const navigate = useNavigate()
  const { library } = useDatasource()

  const [list, setList] = useState<ListState>({ type: 'loading' })
  /**
   * Set when the user picks "Export bundle" from a book's action menu — opens
   * the {@link BundleExportAction} chooser (text-only vs full). Holds the id +
   * title so the chooser can run + name the download without a re-read.
   */
  const [exportTarget, setExportTarget] = useState<{ id: BookId; title: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const books = await library.getAllBooks()
      setList({ type: 'ready', books })
    } catch (e) {
      // Failed load: an explicit error state when nothing is on screen. With
      // books already rendered, keep them.
      setList((prev) =>
        prev.type === 'ready'
          ? prev
          : { type: 'error', message: e instanceof Error ? e.message : 'Failed to load library' },
      )
    }
  }, [library])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Retry button on the error state — flip to loading and re-fetch. */
  const retryListLoad = useCallback((): void => {
    setList({ type: 'loading' })
    void refresh()
  }, [refresh])

  const handleRename = useCallback(
    async (id: BookId): Promise<void> => {
      const book = await library.getBook(id)
      if (!book) return
      const name = window.prompt('New name:', book.title)
      if (!name?.trim() || name.trim() === book.title) return
      const renamed = { ...book, title: name.trim(), updatedAt: Date.now() }
      await library.putBook(renamed)
      await refresh()
    },
    [refresh, library],
  )

  const handleDelete = useCallback(
    async (id: Book['id']): Promise<void> => {
      if (!window.confirm('Remove this book from your library?')) return
      await library.deleteBookCascade(id)
      await refresh()
    },
    [refresh, library],
  )

  // --- per-book export bundle (opens the text-only vs full chooser) ---
  const handleExportBundle = useCallback(
    async (id: BookId): Promise<void> => {
      const book = await library.getBook(id)
      if (!book) return
      setExportTarget({ id, title: book.title })
    },
    [library],
  )

  return {
    list,
    refresh,
    retryListLoad,
    handleRename,
    handleDelete,
    exportTarget,
    handleExportBundle,
    handleExportClose: () => setExportTarget(null),
    navigate,
  }
}
