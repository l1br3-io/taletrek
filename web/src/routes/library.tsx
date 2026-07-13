import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { LibraryList } from '../components/LibraryList'
import { PronunciationReview } from '../components/PronunciationReview'
import { UploadBookModal } from '../components/UploadBookModal'
import { UploadButton } from '../components/UploadButton'
import { DEFAULT_AI_SETTINGS, useSettings } from '../context/settings'
import { useAiTransform } from '../hooks/useAiTransform'
import { useOutline } from '../hooks/useOutline'
import { usePronunciationHints } from '../hooks/usePronunciationHints'
import { getAiEngine } from '../lib/ai/client'
import { opsFromProcessing } from '../lib/ai/runner'
import type { TransformOp } from '../lib/ai/types'
import type { PronunciationEntry } from '../lib/clean/types'
import {
  deleteAudioCacheKeys,
  deleteBookCascade,
  getAllBooks,
  getAudioCacheKeysByBook,
  getBook,
  getChaptersByBook,
  putBook,
} from '../lib/db'
import { ingestBook } from '../lib/ingest'
import { reparseChapters } from '../lib/reprocess'
import { uploadManager } from '../lib/upload/manager'
import { isJobActive, useUploadState } from '../lib/upload/useUpload'
import type { Book, BookId, Chapter } from '../types'

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

export function Library() {
  const navigate = useNavigate()
  const { settings, update } = useSettings()
  const ai = settings.ai ?? DEFAULT_AI_SETTINGS

  const engine = useMemo(() => (ai.enabled ? getAiEngine(ai) : null), [ai])
  const transform = useAiTransform({ engine })
  const outline = useOutline()
  const hints = usePronunciationHints(engine)

  const [list, setList] = useState<ListState>({ type: 'loading' })
  const [runCtx, setRunCtx] = useState<RunContext | null>(null)
  const [hintsTitle, setHintsTitle] = useState<string | null>(null)
  const [parseState, setParseState] = useState<ParseState>({ type: 'idle' })

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
    (ops: TransformOp[], name?: string): void => {
      if (!runCtx) return
      const renamedBook =
        name && runCtx.book.title !== name ? { ...runCtx.book, title: name } : runCtx.book
      if (name && runCtx.book.title !== name) {
        void putBook(renamedBook)
      }
      if (runCtx.kind === 'post') {
        void transform.run({ book: renamedBook, chapters: runCtx.chapters, ops })
      } else {
        const bookId = runCtx.book.id
        void transform.run({
          book: renamedBook,
          resolveChapters: () => reparseChapters(bookId),
          ops,
        })
      }
    },
    [runCtx, transform],
  )

  const onRunCancel = useCallback(
    (name?: string): void => {
      if (transform.state.type === 'running') transform.abort()
      outline.reset()
      const ctx = runCtx
      setRunCtx(null)
      if (!ctx) return
      // Apply rename if the name changed.
      const renamedBook = name && ctx.book.title !== name ? { ...ctx.book, title: name } : ctx.book
      if (name && ctx.book.title !== name) {
        void putBook(renamedBook)
      }
      if (ctx.kind === 'post') {
        proceedWithBook(renamedBook, ctx.chapters)
      }
      // Reprocess: stay in the library (book optionally renamed above).
    },
    [runCtx, transform.state.type, transform.abort, outline, proceedWithBook],
  )

  const handleReprocess = useCallback(
    async (id: BookId): Promise<void> => {
      if (transform.state.type === 'running') return
      const book = await getBook(id)
      if (!book) return
      setRunCtx({ kind: 'reprocess', book })
    },
    [transform.state.type],
  )

  const handleOutline = useCallback(
    async (id: BookId): Promise<void> => {
      if (outline.state.type === 'running') return
      outline.reset()
      const changed = await outline.run(id)
      if (!changed) return
      if (runCtx?.book.id === id) {
        const book = await getBook(id)
        if (!book) return
        if (runCtx.kind === 'post') {
          const fresh = await getChaptersByBook(id)
          setRunCtx({ kind: 'post', book, chapters: fresh })
        } else {
          setRunCtx({ kind: 'reprocess', book })
        }
      }
    },
    [outline, runCtx],
  )

  const handleOutlineAi = useCallback(
    async (id: BookId): Promise<void> => {
      if (outline.state.type === 'running') return
      if (!engine) return
      outline.reset()
      const changed = await outline.runWithAi(id, (paragraphs) => engine.detectOutline(paragraphs))
      if (!changed) return
      if (runCtx?.book.id === id) {
        const book = await getBook(id)
        if (!book) return
        if (runCtx.kind === 'post') {
          const fresh = await getChaptersByBook(id)
          setRunCtx({ kind: 'post', book, chapters: fresh })
        } else {
          setRunCtx({ kind: 'reprocess', book })
        }
      }
    },
    [outline, runCtx, engine],
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

  // --- per-book re-synthesize (deletes cached audio, then re-runs via manager) ---
  const handleResynthesize = useCallback(
    async (id: BookId): Promise<void> => {
      if (uploadManager.isActive()) return // one job at a time
      const book = await getBook(id)
      if (!book) return
      if (
        !window.confirm(
          `Re-synthesize "${book.title}"? This deletes its cached audio and synthesizes every paragraph from scratch using the current voice.`,
        )
      ) {
        return
      }
      const chapters = await getChaptersByBook(id)
      const keys = await getAudioCacheKeysByBook(id)
      await deleteAudioCacheKeys(keys)
      uploadManager.startJob({
        book,
        chapters,
        voiceId: settings.voiceId,
        cleaning: settings.cleaning,
      })
    },
    [settings.voiceId, settings.cleaning],
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Library</h1>
        <UploadButton onSelect={handleSelect} disabled={uploadBusy} />
      </div>

      {parseState.type === 'parsing' && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-accent bg-accent-soft p-4 text-accent"
        >
          <span
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
          <span className="text-sm">Parsing “{parseState.fileName}”…</span>
        </div>
      )}
      {parseState.type === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-lg border border-red-500 bg-red-500/10 p-4 text-red-400"
        >
          <span className="text-sm">{parseState.message}</span>
          <button
            type="button"
            onClick={() => setParseState({ type: 'idle' })}
            aria-label="Dismiss error"
            className="ml-4 text-xs text-red-400/70 hover:text-red-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {outline.state.type === 'running' && (
        <div
          role="status"
          className="rounded-lg border border-accent bg-accent-soft p-4 text-accent"
        >
          Generating outline…
        </div>
      )}
      {outline.state.type === 'done' && (
        <div
          role="status"
          className="flex items-center justify-between rounded-lg border border-accent bg-accent-soft p-4 text-accent"
        >
          <span>{outline.state.message}</span>
          <button
            type="button"
            onClick={outline.reset}
            aria-label="Dismiss outline message"
            className="ml-4 text-xs text-accent/70 hover:text-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {outline.state.type === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-lg border border-red-500 bg-red-500/10 p-4 text-red-400"
        >
          <span>{outline.state.message}</span>
          <button
            type="button"
            onClick={outline.reset}
            aria-label="Dismiss error message"
            className="ml-4 text-xs text-red-400/70 hover:text-red-400"
          >
            <X className="h-4 w-4" />
          </button>
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
          onOutline={handleOutline}
          onResynthesize={settings.synthesizeOnUpload !== 'off' ? handleResynthesize : undefined}
        />
      )}

      {/* Process modal: always shown after upload when AI is enabled (opt-in skip).
          Also used for Reprocess (re-parse original → transform). Cancel/Close
          on post-upload proceeds to synth; on reprocess stays in library. */}
      <UploadBookModal
        open={runCtx !== null}
        state={transform.state}
        initialOps={runInitialOps}
        initialName={runCtx?.book.title}
        onProcess={onRunProcess}
        onCancel={onRunCancel}
        outline={
          runCtx
            ? {
                state: outline.state,
                onGenerate: () => void handleOutline(runCtx.book.id),
                onGenerateAi: engine ? () => void handleOutlineAi(runCtx.book.id) : undefined,
                format: runCtx.book.format,
              }
            : undefined
        }
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
