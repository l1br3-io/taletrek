import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { DEFAULT_AI_SETTINGS, useSettings } from '../../context/settings'
import { useOnline } from '../../hooks/useOnline'
import { getAiEngine } from '../../lib/ai/client'
import { opsFromProcessing } from '../../lib/ai/runner'
import type { TransformOp } from '../../lib/ai/types'
import type { PronunciationEntry } from '../../lib/clean/types'
import { deleteBookCascade, getAllBooks, getBook, getChaptersByBook, putBook } from '../../lib/db'
import { ingestBook } from '../../lib/ingest'
import { reparseChapters } from '../../lib/reprocess'
import { uploadManager } from '../../lib/upload/manager'
import { isJobActive, useUploadState } from '../../lib/upload/useUpload'
import type { Book, BookFormat, BookId, Chapter } from '../../types'
import { useAiTransform } from './useAiTransform'
import { useOutline } from './useOutline'
import { usePronunciationHints } from './usePronunciationHints'

type ListState = { type: 'loading' } | { type: 'ready'; books: Book[] }

type ParseState =
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

/**
 * Route-scoped state for the Library page. Owns the book list, upload/parse
 * flow, and the shared run-modal coordination (post-upload + reprocess) that
 * wires together transforms, outline detection, and pronunciation hints.
 */
export function useLibraryState() {
  const navigate = useNavigate()
  const { settings, update } = useSettings()
  const ai = settings.ai ?? DEFAULT_AI_SETTINGS
  const online = useOnline()

  const engine = useMemo(() => (ai.enabled ? getAiEngine(ai) : null), [ai])
  const transform = useAiTransform({
    ai,
    defs: ai.transformDefs,
    synthMode: settings.synthesizeOnUpload,
    voiceId: settings.voiceId,
    cleaning: settings.cleaning,
  })
  const outline = useOutline()
  const hints = usePronunciationHints(engine)

  const [list, setList] = useState<ListState>({ type: 'loading' })
  const [runCtx, setRunCtx] = useState<RunContext | null>(null)
  const [hintsTitle, setHintsTitle] = useState<string | null>(null)
  const [parseState, setParseState] = useState<ParseState>({ type: 'idle' })
  const [outlineBookId, setOutlineBookId] = useState<BookId | null>(null)
  const [outlineFormat, setOutlineFormat] = useState<BookFormat>('txt')

  const jobState = useUploadState()
  const uploadBusy = isJobActive(jobState)

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

  // When outline detection completes, refresh so cards reflect the new chapter count.
  useEffect(() => {
    if (outline.state.type === 'done') void refresh()
  }, [outline.state, refresh])

  const proceedWithBook = useCallback(
    (book: Book, chapters: Chapter[]): void => {
      if (settings.synthesizeOnUpload === 'off') {
        navigate(`/reader/${book.id}`)
        return
      }
      uploadManager.startJob({
        book,
        chapters,
        voiceId: settings.voiceId,
        cleaning: settings.cleaning,
      })
      navigate(`/reader/${book.id}`)
    },
    [settings.synthesizeOnUpload, settings.voiceId, settings.cleaning, navigate],
  )

  // --- upload + parse ---
  // When AI is enabled, always show the process modal after parse (opt-in skip).
  // When AI is disabled, go straight to synth/reader. The synth job runs in the
  // global upload manager (survives navigation); we navigate to the reader
  // immediately so the user can start reading buffered paragraphs.
  const handleSelect = useCallback(
    async (file: File): Promise<void> => {
      setParseState({ type: 'parsing', fileName: file.name })
      try {
        const result = await ingestBook(file)
        setParseState({ type: 'idle' })
        await refresh()
        if (ai.enabled) {
          setRunCtx({ kind: 'post', book: result.book, chapters: result.chapters })
        } else {
          proceedWithBook(result.book, result.chapters)
        }
      } catch (error) {
        setParseState({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to parse file',
        })
      }
    },
    [ai.enabled, proceedWithBook, refresh],
  )

  // --- run-modal handlers (shared by post-upload + reprocess) ---
  const runInitialOps = useMemo<TransformOp[] | undefined>(() => {
    if (!runCtx) return undefined
    if (runCtx.kind === 'reprocess') {
      return runCtx.book.processing ? opsFromProcessing(runCtx.book.processing) : undefined
    }
    return undefined
  }, [runCtx])

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
    outline.reset()
    const ctx = runCtx
    setRunCtx(null)
    if (!ctx) return
    if (ctx.kind === 'post') {
      proceedWithBook(ctx.book, ctx.chapters)
    }
  }, [runCtx, transform.state.type, transform.abort, outline, proceedWithBook])

  const handleEdit = useCallback(
    async (id: BookId): Promise<void> => {
      if (transform.state.type === 'running') return
      const book = await getBook(id)
      if (!book) return
      setRunCtx({ kind: 'reprocess', book })
    },
    [transform.state.type],
  )

  const refreshRunCtxAfterOutline = useCallback(
    async (id: BookId): Promise<void> => {
      if (runCtx?.book.id !== id) return
      const book = await getBook(id)
      if (!book) return
      if (runCtx.kind === 'post') {
        const fresh = await getChaptersByBook(id)
        setRunCtx({ kind: 'post', book, chapters: fresh })
      } else {
        setRunCtx({ kind: 'reprocess', book })
      }
    },
    [runCtx],
  )

  const handleOutline = useCallback(
    async (id: BookId): Promise<void> => {
      outline.reset()
      const book = await getBook(id)
      setOutlineFormat(book?.format ?? 'txt')
      setOutlineBookId(id)
    },
    [outline],
  )

  const handleOutlineAi = useCallback(async (): Promise<void> => {
    if (!outlineBookId) return
    if (!engine) return
    outline.reset()
    const changed = await outline.runWithAi(outlineBookId, (paragraphs) =>
      engine.detectOutline(paragraphs),
    )
    if (!changed) return
    await refreshRunCtxAfterOutline(outlineBookId)
  }, [outline, engine, outlineBookId, refreshRunCtxAfterOutline])

  const handleOutlinePdf = useCallback(async (): Promise<void> => {
    if (!outlineBookId) return
    outline.reset()
    const changed = await outline.runWithPdfOutline(outlineBookId)
    if (!changed) return
    await refreshRunCtxAfterOutline(outlineBookId)
  }, [outline, outlineBookId, refreshRunCtxAfterOutline])

  const handleOutlineClose = useCallback((): void => {
    outline.reset()
    setOutlineBookId(null)
  }, [outline])

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

  const handleRename = useCallback(
    async (id: BookId): Promise<void> => {
      const book = await getBook(id)
      if (!book) return
      const name = window.prompt('New name:', book.title)
      if (!name || !name.trim() || name.trim() === book.title) return
      const renamed = { ...book, title: name.trim(), updatedAt: Date.now() }
      await putBook(renamed)
      await refresh()
    },
    [refresh],
  )

  const handleDelete = useCallback(
    async (id: Book['id']): Promise<void> => {
      if (!window.confirm('Remove this book from your library?')) return
      await deleteBookCascade(id)
      await refresh()
    },
    [refresh],
  )

  // --- per-book synthesize (resume: skips already-cached paragraphs) ---
  const handleResynthesize = useCallback(
    async (id: BookId): Promise<void> => {
      if (uploadManager.isActive()) return // one job at a time
      const book = await getBook(id)
      if (!book) return
      const chapters = await getChaptersByBook(id)
      uploadManager.startJob({
        book,
        chapters,
        voiceId: settings.voiceId,
        cleaning: settings.cleaning,
        mode: 'resynth',
      })
    },
    [settings.voiceId, settings.cleaning],
  )

  return {
    ai,
    online,
    engine,
    transform,
    outline,
    hints,
    list,
    runCtx,
    hintsTitle,
    parseState,
    uploadBusy,
    synthesizeOnUpload: settings.synthesizeOnUpload,
    runInitialOps,
    handleSelect,
    onRunProcess,
    onRunCancel,
    handleRename,
    handleEdit,
    outlineBookId,
    outlineFormat,
    handleOutline,
    handleOutlineAi,
    handleOutlinePdf,
    handleOutlineClose,
    handlePronunciation,
    onHintsAccept,
    onHintsClose,
    handleDelete,
    handleResynthesize,
    dismissParseError: () => setParseState({ type: 'idle' }),
    navigate,
  }
}
