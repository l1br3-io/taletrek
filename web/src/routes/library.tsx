import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { LibraryList } from '../components/LibraryList'
import { PostProcessModal } from '../components/PostProcessModal'
import { PronunciationReview } from '../components/PronunciationReview'
import { UploadButton } from '../components/UploadButton'
import { DEFAULT_AI_SETTINGS, useSettings } from '../context/settings'
import { useAiTransform } from '../hooks/useAiTransform'
import { usePronunciationHints } from '../hooks/usePronunciationHints'
import { getAiEngine } from '../lib/ai/client'
import { WebLlmEngine } from '../lib/ai/engines/webllm'
import { opsFromProcessing } from '../lib/ai/runner'
import type { TransformOp } from '../lib/ai/types'
import type { PronunciationEntry } from '../lib/clean/types'
import { deleteBookCascade, getAllBooks, getBook } from '../lib/db'
import { ingestBook, type UnsupportedFileError } from '../lib/ingest'
import { reparseChapters } from '../lib/reprocess'
import type { Book, BookId, Chapter } from '../types'

type ListState = { type: 'loading' } | { type: 'ready'; books: Book[] }

type UploadState =
  | { type: 'idle' }
  | { type: 'parsing'; fileName: string }
  | { type: 'error'; message: string }

/**
 * Unified context for the run-modal (post-upload + reprocess share one modal +
 * one transform hook — only one transform runs at a time, guarded by the hook).
 */
type RunContext =
  | { kind: 'post'; book: Book; chapters: Chapter[] }
  | { kind: 'reprocess'; book: Book }

function isUnsupportedFileError(e: unknown): e is UnsupportedFileError {
  return e instanceof Error && e.name === 'UnsupportedFileError'
}

export function Library() {
  const navigate = useNavigate()
  const { settings, update } = useSettings()
  const ai = settings.ai ?? DEFAULT_AI_SETTINGS

  const engine = useMemo(() => (ai.enabled ? getAiEngine(ai) : null), [ai])
  const prepare = useMemo<
    ((onProgress: (fraction: number) => void) => Promise<void>) | undefined
  >(() => {
    if (!ai.enabled || ai.backend !== 'in-browser') return undefined
    return async (onProgress) => {
      if (engine instanceof WebLlmEngine && !(await engine.isReady())) {
        await engine.load(onProgress)
      }
    }
  }, [ai.enabled, ai.backend, engine])
  const transform = useAiTransform({ engine, prepare })
  const hints = usePronunciationHints(engine)

  const [list, setList] = useState<ListState>({ type: 'loading' })
  const [upload, setUpload] = useState<UploadState>({ type: 'idle' })
  const [stashedOps, setStashedOps] = useState<TransformOp[]>([])
  const [preModalOpen, setPreModalOpen] = useState(false)
  const [runCtx, setRunCtx] = useState<RunContext | null>(null)
  const [hintsTitle, setHintsTitle] = useState<string | null>(null)
  const prePickResolveRef = useRef<((proceed: boolean) => void) | null>(null)

  const refresh = useCallback(async () => {
    const books = await getAllBooks()
    setList({ type: 'ready', books })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // When a transform completes, refresh so cards reflect new processing/progress.
  useEffect(() => {
    if (transform.state.type === 'done') void refresh()
  }, [transform.state, refresh])

  // --- pre-upload gate (modal.beforeUpload) ---
  const handleBeforePick = useCallback((): Promise<boolean> => {
    if (!ai.enabled || !ai.modal.beforeUpload) return Promise.resolve(true)
    setPreModalOpen(true)
    return new Promise<boolean>((resolve) => {
      prePickResolveRef.current = resolve
    })
  }, [ai.enabled, ai.modal.beforeUpload])

  const closePreModal = useCallback((ops: TransformOp[] | null): void => {
    setPreModalOpen(false)
    if (ops && ops.length > 0) setStashedOps(ops)
    // Both Process and Cancel proceed to the file picker (PRD: "cancel proceeds normally").
    prePickResolveRef.current?.(true)
    prePickResolveRef.current = null
  }, [])

  // --- upload + parse ---
  const handleSelect = useCallback(
    async (file: File): Promise<void> => {
      setUpload({ type: 'parsing', fileName: file.name })
      try {
        const { book, chapters } = await ingestBook(file)
        await refresh()
        setUpload({ type: 'idle' })
        // Post-upload modal fires when afterUpload is on OR the user pre-stashed ops
        // (so beforeUpload-only still surfaces the choices for confirmation).
        const wantPost = ai.enabled && (ai.modal.afterUpload || stashedOps.length > 0)
        if (wantPost) {
          setRunCtx({ kind: 'post', book, chapters })
        } else {
          navigate(`/reader/${book.id}`)
        }
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
    },
    [ai.enabled, ai.modal.afterUpload, stashedOps.length, navigate, refresh],
  )

  // --- run-modal handlers (shared by post-upload + reprocess) ---
  const runInitialOps = useMemo<TransformOp[] | undefined>(() => {
    if (!runCtx) return undefined
    if (runCtx.kind === 'reprocess') {
      return runCtx.book.processing ? opsFromProcessing(runCtx.book.processing) : undefined
    }
    return stashedOps.length > 0 ? stashedOps : undefined
  }, [runCtx, stashedOps])

  const onRunProcess = useCallback(
    (ops: TransformOp[]): void => {
      if (!runCtx) return
      if (runCtx.kind === 'post') {
        void transform.run({ book: runCtx.book, chapters: runCtx.chapters, ops })
      } else {
        const bookId = runCtx.book.id
        void transform.run({
          book: runCtx.book,
          resolveChapters: () => reparseChapters(bookId),
          ops,
        })
      }
    },
    [runCtx, transform],
  )

  const onRunCancel = useCallback((): void => {
    if (transform.state.type === 'running') transform.abort()
    const wasPost = runCtx?.kind === 'post'
    const bookId = runCtx?.book.id
    setRunCtx(null)
    setStashedOps([])
    // Post-upload: open the reader (unprocessed on cancel, processed on done→close).
    // Reprocess: stay in the library.
    if (wasPost && bookId) navigate(`/reader/${bookId}`)
  }, [runCtx, transform.state.type, transform.abort, navigate])

  const handleReprocess = useCallback(
    async (id: BookId): Promise<void> => {
      if (transform.state.type === 'running') return
      const book = await getBook(id)
      if (!book) return
      setRunCtx({ kind: 'reprocess', book })
    },
    [transform.state.type],
  )

  const handlePronunciation = useCallback(
    async (id: BookId): Promise<void> => {
      const book = await getBook(id)
      if (!book) return
      setHintsTitle(book.title)
      void hints.scan(id)
    },
    [hints],
  )

  const onHintsAccept = useCallback(
    async (entries: PronunciationEntry[]): Promise<void> => {
      // Merge into the global dictionary, dedup by find (case-insensitive).
      // Existing entries win so a prior manual edit isn't clobbered.
      const existing = settings.cleaning.pronunciation
      const seen = new Set(existing.map((e) => e.find.toLowerCase()))
      const merged = [...existing]
      for (const entry of entries) {
        const key = entry.find.toLowerCase()
        if (!seen.has(key)) {
          merged.push(entry)
          seen.add(key)
        }
      }
      await update({ cleaning: { ...settings.cleaning, pronunciation: merged } })
      hints.reset()
      setHintsTitle(null)
    },
    [settings.cleaning, update, hints],
  )

  const onHintsClose = useCallback((): void => {
    hints.reset()
    setHintsTitle(null)
  }, [hints])

  const handleDelete = useCallback(
    async (id: Book['id']): Promise<void> => {
      if (!window.confirm('Remove this book from your library?')) return
      await deleteBookCascade(id)
      await refresh()
    },
    [refresh],
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Library</h1>
        <UploadButton
          onSelect={handleSelect}
          onBeforePick={handleBeforePick}
          disabled={upload.type === 'parsing'}
        />
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
          onReprocess={ai.enabled ? handleReprocess : undefined}
          onPronunciation={ai.enabled ? handlePronunciation : undefined}
        />
      )}

      {/* Pre-upload modal: collect ops only (no book yet); both Process + Cancel
          proceed to the file picker. */}
      <PostProcessModal
        open={preModalOpen}
        state={{ type: 'idle' }}
        onProcess={closePreModal}
        onCancel={() => closePreModal(null)}
      />

      {/* Post-upload + Reprocess modal: one instance, one transform hook.
          Post-upload runs over the just-parsed chapters; Reprocess re-parses the
          original file (pristine paragraphs) via resolveChapters. Cancel/Close
          aborts; post-upload then opens the reader, reprocess stays in library. */}
      <PostProcessModal
        open={runCtx !== null}
        state={transform.state}
        initialOps={runInitialOps}
        onProcess={onRunProcess}
        onCancel={onRunCancel}
      />

      {/* Pronunciation review: scans the opening chapter for name/foreign-word
          candidates; accepted entries merge into the global dictionary. */}
      <PronunciationReview
        open={hints.state.type !== 'idle'}
        state={hints.state}
        bookTitle={hintsTitle}
        onAccept={onHintsAccept}
        onClose={onHintsClose}
      />
    </div>
  )
}
