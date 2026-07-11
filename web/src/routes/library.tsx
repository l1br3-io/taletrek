import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { LibraryList } from '../components/LibraryList'
import { UploadButton } from '../components/UploadButton'
import { deleteBookCascade, getAllBooks } from '../lib/db'
import { ingestBook, type UnsupportedFileError } from '../lib/ingest'
import type { Book } from '../types'

type ListState = { type: 'loading' } | { type: 'ready'; books: Book[] }

type UploadState =
  | { type: 'idle' }
  | { type: 'parsing'; fileName: string }
  | { type: 'error'; message: string }

function isUnsupportedFileError(e: unknown): e is UnsupportedFileError {
  return e instanceof Error && e.name === 'UnsupportedFileError'
}

export function Library() {
  const navigate = useNavigate()
  const [list, setList] = useState<ListState>({ type: 'loading' })
  const [upload, setUpload] = useState<UploadState>({ type: 'idle' })

  const refresh = useCallback(async () => {
    const books = await getAllBooks()
    setList({ type: 'ready', books })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSelect = async (file: File): Promise<void> => {
    setUpload({ type: 'parsing', fileName: file.name })
    try {
      const { book } = await ingestBook(file)
      await refresh()
      setUpload({ type: 'idle' })
      navigate(`/reader/${book.id}`)
    } catch (error) {
      setUpload({
        type: 'error',
        message: isUnsupportedFileError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Failed to parse file',
      })
    }
  }

  const handleDelete = async (id: Book['id']): Promise<void> => {
    if (!window.confirm('Remove this book from your library?')) return
    await deleteBookCascade(id)
    await refresh()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Library</h1>
        <UploadButton onSelect={handleSelect} disabled={upload.type === 'parsing'} />
      </div>

      {upload.type === 'parsing' && (
        <div
          role="status"
          className="rounded-lg border border-accent bg-accent-soft p-4 text-accent"
        >
          Parsing “{upload.fileName}”…
        </div>
      )}
      {upload.type === 'error' && (
        <div
          role="alert"
          className="rounded-lg border border-red-500 bg-red-500/10 p-4 text-red-400"
        >
          {upload.message}
        </div>
      )}

      {list.type === 'loading' && <p className="text-muted">Loading…</p>}
      {list.type === 'ready' && (
        <LibraryList
          books={list.books}
          onOpen={(id) => navigate(`/reader/${id}`)}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
