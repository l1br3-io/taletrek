import { useCallback, useEffect, useRef, useState } from 'react'
import { cleanChapters } from '../lib/clean'
import type { CleaningConfig } from '../lib/clean/types'
import { ingestBook, type UnsupportedFileError } from '../lib/ingest'
import { preSynthesizeBook } from '../lib/pre-synth'
import { ttsClient } from '../lib/tts/client'
import type { Book, BookId, Chapter, VoiceId } from '../types'

export type UploadState =
  | { type: 'idle' }
  | { type: 'parsing'; fileName: string }
  | { type: 'voiceDownload'; fileName: string; fraction: number }
  | { type: 'synthesizing'; fileName: string; done: number; total: number }
  | { type: 'error'; message: string }

function isUnsupportedFileError(e: unknown): e is UnsupportedFileError {
  return e instanceof Error && e.name === 'UnsupportedFileError'
}

/**
 * Upload state machine: parse → (optional) pre-synthesize → navigate.
 *
 * The route calls `parse(file)`, then either `synthBook(book, chapters)` or
 * `skipToReader()` depending on the `synthesizeOnUpload` setting and whether
 * a post-process modal is needed. `synthBook` cleans chapters internally
 * (using the latest cleaning config via a ref), so the caller passes raw
 * chapters. Navigation happens on completion, cancel, or error — pre-synth
 * failure is non-fatal (the reader handles on-demand synthesis).
 *
 * `onParsed` is called at the END of `synthBook` / `skipToReader` (just before
 * navigation) — NOT after `parse`. This ensures the library list doesn't show
 * the new book until the full upload pipeline (parse + synth) is done, so the
 * user never sees a half-ready book.
 */
export function useBookUpload(opts: {
  voiceId: VoiceId
  cleaning: CleaningConfig
  onNavigate: (bookId: BookId) => void
  onParsed?: () => Promise<void>
}): {
  upload: UploadState
  parse: (file: File) => Promise<{ book: Book; chapters: Chapter[] } | undefined>
  synthBook: (book: Book, chapters: Chapter[]) => Promise<void>
  skipToReader: () => void
  reset: () => void
} {
  const { onNavigate, onParsed } = opts
  const voiceIdRef = useRef(opts.voiceId)
  voiceIdRef.current = opts.voiceId
  const cleaningRef = useRef(opts.cleaning)
  cleaningRef.current = opts.cleaning

  const [upload, setUpload] = useState<UploadState>({ type: 'idle' })
  const cancelRef = useRef(false)
  const bookIdRef = useRef<BookId | null>(null)
  const fileNameRef = useRef<string>('')
  const mountedRef = useRef(true)

  useEffect(
    () => () => {
      mountedRef.current = false
    },
    [],
  )

  const parse = useCallback(
    async (file: File): Promise<{ book: Book; chapters: Chapter[] } | undefined> => {
      fileNameRef.current = file.name
      setUpload({ type: 'parsing', fileName: file.name })
      try {
        const result = await ingestBook(file)
        bookIdRef.current = result.book.id
        // NOTE: onParsed (library refresh) is deferred to synthBook/skipToReader
        // so the book doesn't appear in the list until the full pipeline is done.
        return result
      } catch (error) {
        if (mountedRef.current) {
          setUpload({
            type: 'error',
            message: isUnsupportedFileError(error)
              ? error.message
              : error instanceof Error
                ? error.message
                : 'Failed to parse file',
          })
        }
        return undefined
      }
    },
    [],
  )

  const synthBook = useCallback(
    async (book: Book, chapters: Chapter[]): Promise<void> => {
      cancelRef.current = false
      bookIdRef.current = book.id
      const cleaned = cleanChapters(chapters, cleaningRef.current)

      try {
        await preSynthesizeBook({
          bookId: book.id,
          chapters: cleaned,
          voiceId: voiceIdRef.current,
          engine: ttsClient,
          onVoiceDownload: (fraction) => {
            if (mountedRef.current) {
              setUpload({ type: 'voiceDownload', fileName: fileNameRef.current, fraction })
            }
          },
          onProgress: (done, total) => {
            if (mountedRef.current) {
              setUpload({ type: 'synthesizing', fileName: fileNameRef.current, done, total })
            }
          },
          isCancelled: () => cancelRef.current,
        })
      } catch {
        // Pre-synth failure is non-fatal — navigate to reader (on-demand synth).
      }

      if (cancelRef.current) return // skipToReader handled navigation
      await onParsed?.()
      if (mountedRef.current) setUpload({ type: 'idle' })
      onNavigate(book.id)
    },
    [onNavigate, onParsed],
  )

  const skipToReader = useCallback((): void => {
    cancelRef.current = true
    const id = bookIdRef.current
    if (id) {
      void onParsed?.().then(() => {
        if (mountedRef.current) setUpload({ type: 'idle' })
        onNavigate(id)
      })
    }
  }, [onNavigate, onParsed])

  const reset = useCallback((): void => {
    setUpload({ type: 'idle' })
  }, [])

  return { upload, parse, synthBook, skipToReader, reset }
}
