import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { DEFAULT_AI_SETTINGS, useSettings } from '../../context/settings'
import { useOnline } from '../../hooks/useOnline'
import { getAiEngine } from '../../lib/ai/client'
import { getApiKey } from '../../lib/ai/keyring'
import { opsFromProcessing } from '../../lib/ai/runner'
import type { TransformOp } from '../../lib/ai/types'
import type { PronunciationEntry } from '../../lib/clean/types'
import { deleteBookCascade, getAllBooks, getBook, getChaptersByBook, putBook } from '../../lib/db'
import { ingestBook } from '../../lib/ingest'
import { reparseChapters } from '../../lib/reprocess'
import { bookTransformManager } from '../../lib/transform/manager'
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
  /**
   * The active provider's API key, read live from the in-memory keyring on
   * every render. `getAiEngine` deliberately doesn't check the key (engines
   * defer to {@link CloudLlmEngine.requireKey} at request time so the failure
   * surfaces next to the action that caused it), which means an engine is
   * returned even when the key is missing — and a returned engine would make
   * `aiUsable` true, popping the transform modal for a Generate click that
   * can only fail. Checking the key here closes that gap. The keyring isn't
   * reactive, but it doesn't need to be: any Settings edit triggers a
   * SettingsProvider re-hydrate → re-render → this computation re-runs.
   *
   * When there's no `activeProviderId`, the keyring check is skipped — in
   * production `getAiEngine` already returns null in that case, so the
   * engine check downstream is the binding constraint. (Tests mock the
   * engine to bypass that, and shouldn't be punished for not also seeding a
   * key.)
   */
  const activeProviderId = ai.cloud?.activeProviderId
  const activeProviderHasKey = activeProviderId ? !!getApiKey(activeProviderId) : true
  /**
   * AI is actually usable right now: enabled in settings, online, a
   * provider/engine is resolvable, AND the active provider's key is loaded in
   * the in-memory keyring. Drives whether the post-upload modal opens and
   * whether the Transform / Pronunciation menu items are flagged. When
   * `false`, upload proceeds straight to synth/reader — same as
   * `ai.enabled === false`. Saves the user from a useless "Skip-only" modal
   * (offline, no provider, no key) or a Generate click that throws in the
   * reader.
   */
  const aiUsable = ai.enabled && online && engine !== null && activeProviderHasKey
  /**
   * When AI is enabled but not usable, name the reason so the chip + sheet
   * can speak specifically. `null` when AI is fully usable OR fully disabled
   * (in the disabled case there's nothing to surface — the user opted out).
   * Drives the ambient `<AiStatusChip>` on the library and the explanatory
   * `<FeatureUnavailableSheet>` shown when the user clicks a flagged AI menu
   * item (Transform / Pronunciation).
   */
  const aiUnusableReason: 'no-provider' | 'no-key' | 'misconfigured' | 'offline' | null =
    !ai.enabled
      ? null
      : !online
        ? 'offline'
        : engine === null
          ? activeProviderId
            ? 'misconfigured'
            : 'no-provider'
          : !activeProviderHasKey
            ? 'no-key'
            : null
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
  /**
   * Set when the user clicks an AI menu item (Reprocess / Pronunciation) while
   * `aiUnusableReason !== null`. The explanatory `<FeatureUnavailableSheet>`
   * reads this to show reason-specific copy + a deep-link to Settings → AI.
   */
  const [unavailableFeature, setUnavailableFeature] = useState<{
    feature: 'transform' | 'pronunciation'
  } | null>(null)

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
      // Guard against concurrent jobs (issue #3). The singleton also throws,
      // but that error propagates uncaught from this callback — a silent
      // skip here matches `handleResynthesize`'s pattern below.
      if (uploadManager.isActive()) return
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
  // When AI is usable (enabled + online + provider configured) AND at least one
  // transform definition exists, show the transform modal after parse
  // (opt-in skip). Otherwise go straight to synth/reader — showing a
  // Skip-only modal (no defs, offline, no provider) would be noise, and a
  // Generate click would just throw in the reader. The manual "Transform"
  // menu item still opens the modal regardless of defs so the empty-state can
  // point the user at Settings. The synth job runs in the global upload
  // manager (survives navigation); we navigate to the reader immediately so
  // the user can start reading buffered paragraphs.
  const handleSelect = useCallback(
    async (file: File): Promise<void> => {
      setParseState({ type: 'parsing', fileName: file.name })
      try {
        const result = await ingestBook(file)
        setParseState({ type: 'idle' })
        await refresh()
        if (aiUsable && ai.transformDefs.length > 0) {
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
    [aiUsable, ai.transformDefs, proceedWithBook, refresh],
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

  /**
   * Stream-apply the selected ops via `bookTransformManager` and navigate to
   * the reader to watch the generation (M13 / ADR-0012). Used by the
   * `UploadBookModal`'s "Generate" button — alternative to `onRunProcess`
   * which runs the legacy non-streaming path.
   *
   * Flow: get fresh chapters from IDB (reparse if reprocessing), call the
   * manager's `start()`, close the modal, navigate. The reader subscribes to
   * the manager on mount and shows the streaming chunk block.
   */
  const onRunGenerate = useCallback(
    async (ops: TransformOp[]): Promise<void> => {
      console.log('[taletrek] onRunGenerate clicked', { ops, hasRunCtx: !!runCtx })
      if (!runCtx) {
        console.warn('[taletrek] onRunGenerate: no runCtx, returning')
        return
      }
      const book = runCtx.book
      const chapters =
        runCtx.kind === 'post' ? runCtx.chapters : await reparseChapters(book.id).catch(() => [])
      if (chapters.length === 0) {
        console.warn('[taletrek] onRunGenerate: no chapters after reparse, returning')
        return
      }
      // Close the modal first so the user sees the reader immediately.
      setRunCtx(null)
      navigate(`/reader/${book.id}`)
      // Then kick the manager. Operational failures (paused job for another
      // book, synth in progress, AI disabled, book not found) surface via
      // `state.error` and the reader's GenerationBanner shows them; the call
      // itself resolves cleanly. We log any unexpected throw for diagnosis.
      try {
        await bookTransformManager.start(
          {
            book,
            chapters,
            ops,
            voiceId: settings.voiceId,
            cleaning: settings.cleaning,
          },
          {
            ai,
            defs: ai.transformDefs,
            synthEnabled: settings.synthesizeOnUpload !== 'off',
          },
        )
      } catch (e) {
        console.error('[taletrek] bookTransformManager.start threw unexpectedly:', e)
      }
    },
    [runCtx, navigate, settings.voiceId, settings.cleaning, settings.synthesizeOnUpload, ai],
  )

  const handleTransform = useCallback(
    async (id: BookId): Promise<void> => {
      // AI enabled but not usable → open the explanatory sheet instead of the
      // transform modal. Lets the user see *why* the feature isn't ready and
      // hop straight to Settings → AI to fix it (rather than silently hiding
      // the menu item, which leaves them wondering where AI went).
      if (aiUnusableReason) {
        setUnavailableFeature({ feature: 'transform' })
        return
      }
      if (transform.state.type === 'running') return
      const book = await getBook(id)
      if (!book) return
      setRunCtx({ kind: 'reprocess', book })
    },
    [aiUnusableReason, transform.state.type],
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
      // AI enabled but not usable → same explanatory sheet as Reprocess.
      if (aiUnusableReason) {
        setUnavailableFeature({ feature: 'pronunciation' })
        return
      }
      const book = await getBook(id)
      if (!book) return
      setHintsTitle(book.title)
      void hints.scan(id)
    },
    [aiUnusableReason, hints],
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
      // Cancel any in-progress synth/transform for THIS book before the
      // cascade-delete races the managers. Without this, a running job keeps
      // writing to a book that no longer exists — ghost banner, leaked
      // audio-cache pin, stray IDB errors in the finally path. If another
      // book's job is active, refuse the delete and surface why.
      const uploadResult = await uploadManager.cancelForBook(id)
      if (uploadResult.type === 'blocked') {
        window.alert(
          `Can't delete — synthesizing “${uploadResult.activeBookTitle}” right now. Cancel it first.`,
        )
        return
      }
      const transformResult = await bookTransformManager.cancelForBook(id)
      if (transformResult.type === 'blocked') {
        window.alert(
          `Can't delete — generating “${transformResult.activeBookTitle}” right now. Cancel it first.`,
        )
        return
      }
      const willCancel = uploadResult.type === 'cancelled' || transformResult.type === 'cancelled'
      const message = willCancel
        ? 'Remove this book from your library? Any in-progress synthesis will be cancelled.'
        : 'Remove this book from your library?'
      if (!window.confirm(message)) return
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
    aiUsable,
    aiUnusableReason,
    unavailableFeature,
    onUnavailableFeatureClose: () => setUnavailableFeature(null),
    transform,
    outline,
    hints,
    list,
    refresh,
    runCtx,
    hintsTitle,
    parseState,
    uploadBusy,
    synthesizeOnUpload: settings.synthesizeOnUpload,
    runInitialOps,
    handleSelect,
    onRunProcess,
    onRunCancel,
    onRunGenerate,
    handleRename,
    handleTransform,
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
