import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { LibraryList } from '../components/LibraryList'
import { PostProcessModal } from '../components/PostProcessModal'
import { UploadButton } from '../components/UploadButton'
import { DEFAULT_AI_SETTINGS, useSettings } from '../context/settings'
import { useAiTransform } from '../hooks/useAiTransform'
import { getAiEngine } from '../lib/ai/client'
import { WebLlmEngine } from '../lib/ai/engines/webllm'
import type { TransformOp } from '../lib/ai/types'
import { deleteBookCascade, getAllBooks } from '../lib/db'
import { ingestBook, type UnsupportedFileError } from '../lib/ingest'
import type { Book, Chapter } from '../types'

type ListState = { type: 'loading' } | { type: 'ready'; books: Book[] }

type UploadState =
  | { type: 'idle' }
  | { type: 'parsing'; fileName: string }
  | { type: 'error'; message: string }

interface PostContext {
  book: Book
  chapters: Chapter[]
}

function isUnsupportedFileError(e: unknown): e is UnsupportedFileError {
  return e instanceof Error && e.name === 'UnsupportedFileError'
}

export function Library() {
  const navigate = useNavigate()
  const { settings } = useSettings()
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

  const [list, setList] = useState<ListState>({ type: 'loading' })
  const [upload, setUpload] = useState<UploadState>({ type: 'idle' })
  const [stashedOps, setStashedOps] = useState<TransformOp[]>([])
  const [preModalOpen, setPreModalOpen] = useState(false)
  const [post, setPost] = useState<PostContext | null>(null)
  const prePickResolveRef = useRef<((proceed: boolean) => void) | null>(null)

  const refresh = useCallback(async () => {
    const books = await getAllBooks()
    setList({ type: 'ready', books })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

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
          setPost({ book, chapters })
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

  // --- post-upload modal handlers ---
  const onPostProcess = useCallback(
    (ops: TransformOp[]): void => {
      if (!post) return
      void transform.run({ book: post.book, chapters: post.chapters, ops })
    },
    [post, transform],
  )

  const onPostCancel = useCallback((): void => {
    if (transform.state.type === 'running') transform.abort()
    const bookId = post?.book.id
    setPost(null)
    setStashedOps([])
    if (bookId) navigate(`/reader/${bookId}`)
  }, [post, transform, navigate])

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

      {/* Post-upload modal: runs the selected transforms; Cancel/Close aborts +
          opens the reader (unprocessed on cancel, processed on done→close). */}
      <PostProcessModal
        open={post !== null}
        state={transform.state}
        initialOps={stashedOps}
        onProcess={onPostProcess}
        onCancel={onPostCancel}
      />
    </div>
  )
}
