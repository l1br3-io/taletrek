import { useEffect, useState } from 'react'
import { ReaderView } from '../components/ReaderView'
import { UploadButton } from '../components/UploadButton'
import { getChaptersByBook, getMostRecentBook, putBook, putBookFile, putChapters } from '../lib/db'
import { parseInWorker } from '../lib/parse/client'
import { formatForFile } from '../lib/parse/util'
import { type Book, type BookFile, type Chapter, newBookId, newChapterId } from '../types'

type LoadState =
  | { type: 'loading' }
  | { type: 'empty' }
  | { type: 'ready'; book: Book; chapters: Chapter[] }

type UploadState =
  | { type: 'idle' }
  | { type: 'parsing'; fileName: string }
  | { type: 'error'; message: string }

export function Reader() {
  const [load, setLoad] = useState<LoadState>({ type: 'loading' })
  const [upload, setUpload] = useState<UploadState>({ type: 'idle' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const book = await getMostRecentBook()
      if (cancelled) return
      if (!book) {
        setLoad({ type: 'empty' })
        return
      }
      const chapters = await getChaptersByBook(book.id)
      if (cancelled) return
      setLoad({ type: 'ready', book, chapters })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSelect = async (file: File): Promise<void> => {
    const format = formatForFile(file.name)
    if (!format) {
      setUpload({ type: 'error', message: `Unsupported file type: ${file.name}` })
      return
    }
    setUpload({ type: 'parsing', fileName: file.name })
    try {
      const result = await parseInWorker(file)
      const now = Date.now()
      const id = newBookId()
      const book: Book = {
        id,
        title: result.title,
        format,
        chapterCount: result.chapters.length,
        createdAt: now,
        updatedAt: now,
      }
      const chapters: Chapter[] = result.chapters.map((parsed, index) => ({
        id: newChapterId(),
        bookId: id,
        index,
        title: parsed.title,
        paragraphs: parsed.paragraphs,
      }))
      const bookFile: BookFile = {
        bookId: id,
        blob: file,
        name: file.name,
        type: file.type,
        size: file.size,
      }
      await Promise.all([putBook(book), putChapters(chapters), putBookFile(bookFile)])
      setLoad({ type: 'ready', book, chapters })
      setUpload({ type: 'idle' })
    } catch (error) {
      setUpload({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to parse file',
      })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
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

      {load.type === 'loading' && <p className="text-muted">Loading…</p>}
      {load.type === 'empty' && (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold">Reader</h1>
          <div className="rounded-lg border border-dashed border-line bg-surface p-10 text-center">
            <p className="text-muted">
              No book loaded yet. Upload a PDF, EPUB, or TXT to start reading.
            </p>
          </div>
        </div>
      )}
      {load.type === 'ready' && <ReaderView book={load.book} chapters={load.chapters} />}
    </div>
  )
}
