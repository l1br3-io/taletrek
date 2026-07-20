import { Locate, Pause, Play, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useSettings } from '../../context/settings'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useOnline } from '../../hooks/useOnline'
import { cleanChapters } from '../../lib/clean'
import { getBook, getChaptersByBook, getMostRecentBook, updateParagraph } from '../../lib/db'
import { scrollIntoViewCenter, scrollToTop } from '../../lib/scroll'
import { bookTransformManager } from '../../lib/transform/manager'
import { useBookTransformState } from '../../lib/transform/useBookTransformState'
import { ttsClient } from '../../lib/tts/client'
import { useUploadState } from '../../lib/upload/useUpload'
import {
  type Book,
  type BookId,
  type BookPosition,
  bookId,
  type Chapter,
  type ChapterId,
} from '../../types'
import { Outline } from './Outline'
import { ParagraphTransformModal } from './ParagraphTransformModal'
import { PlayerBar } from './PlayerBar'
import { flattenParagraphs } from './players/types'
import { usePlayer } from './players/usePlayer'
import { ReaderView } from './ReaderView'
import { PreparingElapsedTimer } from './StreamingBlock'
import { useCachedParagraphs } from './useCachedParagraphs'
import { useElementVisible } from './useElementVisible'
import { useMediaSession } from './useMediaSession'
import { useParagraphTransform } from './useParagraphTransform'
import { useProgressPersistence } from './useProgressPersistence'

function resolveInitialIndex(
  chapters: readonly Chapter[],
  position: BookPosition | undefined,
): number {
  if (!position) return 0
  const flat = flattenParagraphs(chapters)
  const exact = flat.findIndex(
    (p) => p.chapterIndex === position.chapterIndex && p.paragraphIndex === position.paragraphIndex,
  )
  if (exact >= 0) return exact
  const chapterStart = flat.findIndex((p) => p.chapterIndex === position.chapterIndex)
  return chapterStart >= 0 ? chapterStart : 0
}

type LoadState =
  | { type: 'loading' }
  | { type: 'not-found' }
  | { type: 'ready'; book: Book; chapters: Chapter[] }

/** Playback view for a loaded book — owns the player hook (keyed by book.id). */
function ReaderPane({
  book,
  chapters,
  onParagraphChanged,
}: {
  book: Book
  chapters: Chapter[]
  onParagraphChanged: (chapterId: ChapterId, rawParagraphIndex: number, text: string) => void
}) {
  const { settings, update } = useSettings()
  const online = useOnline()
  const cleanedChapters = useMemo(
    () => cleanChapters(chapters, settings.cleaning),
    [chapters, settings.cleaning],
  )
  const cleanedParagraphs = useMemo(() => flattenParagraphs(cleanedChapters), [cleanedChapters])
  const isMobile = useIsMobile()

  // Background synth (upload manager): if a job is running for THIS book,
  // surface buffer state so the player, ReaderView, and Outline can show
  // per-paragraph "ready/pending" indicators and the player skips its own
  // redundant primeAhead (the background job fills the cache).
  const jobState = useUploadState()
  const backgroundActive =
    (jobState.type === 'synthesizing' || jobState.type === 'voiceDownload') &&
    jobState.book.id === book.id
  const backgroundBufferedIds =
    jobState.type === 'synthesizing' && jobState.book.id === book.id
      ? jobState.synthesizedParagraphIds
      : undefined
  // Mobile synthesis lockdown (ADR-0010 / M11): on a coarse-pointer device,
  // pin the reader's playback bar to a synthesis mode while this book's job is
  // active or paused — playback during synthesis would fall back to the
  // lock-broken per-paragraph engine.
  const jobForThisBook =
    (jobState.type === 'synthesizing' ||
      jobState.type === 'voiceDownload' ||
      jobState.type === 'encoding' ||
      jobState.type === 'cancelling' ||
      jobState.type === 'paused') &&
    jobState.book.id === book.id
  const synthLockdown = isMobile && jobForThisBook
  const lockdownLabel =
    jobState.type === 'synthesizing'
      ? `Synthesizing… ${jobState.done}/${jobState.total}`
      : jobState.type === 'voiceDownload'
        ? 'Downloading voice…'
        : jobState.type === 'encoding'
          ? 'Encoding audiobook…'
          : jobState.type === 'paused'
            ? `Paused · ${jobState.done}/${jobState.total}`
            : jobState.type === 'cancelling'
              ? 'Cancelling…'
              : undefined

  // Persistent cache probe: which paragraphs are pre-rendered even when no
  // background synth job is running. Bumps after a job completes to pick up
  // newly-synthesized entries.
  const [cacheRefreshToken, setCacheRefreshToken] = useState(0)
  const prevBackgroundActive = useRef(false)
  useEffect(() => {
    if (prevBackgroundActive.current && !backgroundActive) {
      setCacheRefreshToken((n) => n + 1)
    }
    prevBackgroundActive.current = backgroundActive
  }, [backgroundActive])
  const persistentCachedIds = useCachedParagraphs(
    book.id,
    settings.voiceId,
    cleanedChapters,
    cacheRefreshToken,
  )

  // Session-synthesized IDs: paragraphs the player synthesized on-demand or
  // via look-ahead during this session. These are in the M8 cache but the
  // persistent probe hasn't refreshed to reflect them. Cleared on voice /
  // chapters change (stale keys after voice switch).
  const [sessionSynthIds, setSessionSynthIds] = useState<Set<string>>(new Set())
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps — clear stale IDs when voice/text changes
  useEffect(() => {
    setSessionSynthIds(new Set())
  }, [settings.voiceId, cleanedChapters])
  const handleParagraphSynthesized = useCallback((id: string) => {
    setSessionSynthIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  // ReaderView / Outline: merge all sources of "has audio" — persistent cache,
  // background job progress, and session on-demand synth.
  const bufferedParagraphIds = useMemo(() => {
    const merged = new Set(persistentCachedIds)
    if (backgroundBufferedIds) {
      for (const id of backgroundBufferedIds) merged.add(id)
    }
    for (const id of sessionSynthIds) merged.add(id)
    return merged
  }, [persistentCachedIds, backgroundBufferedIds, sessionSynthIds])

  // Resume: compute the seed index from the saved position + cleaned view. The
  // player only honors `initialIndex` on first render (mount), so later
  // recomputes (e.g. cleaning toggled) are intentionally ignored by the hook.
  const initialIndex = useMemo(
    () => resolveInitialIndex(cleanedChapters, book.position),
    [cleanedChapters, book.position],
  )

  const player = usePlayer(
    {
      chapters: cleanedChapters,
      voiceId: settings.voiceId,
      playbackRate: settings.playbackRate,
      engine: ttsClient,
      initialIndex,
      bookId: book.id,
      backgroundActive,
      backgroundBufferedIds,
      cachedParagraphIds: persistentCachedIds,
      onParagraphSynthesized: handleParagraphSynthesized,
    },
    { isMobile },
  )
  useMediaSession({
    player,
    bookTitle: book.title,
    chapters: cleanedChapters,
    playbackRate: settings.playbackRate,
  })

  // --- Scroll-to-current infrastructure (F4/F5) ---
  const activeParagraphRef = useRef<HTMLParagraphElement | null>(null)
  const activeInView = useElementVisible(activeParagraphRef, player.currentParagraphId)
  const scrollToCurrent = useCallback(() => scrollIntoViewCenter(activeParagraphRef.current), [])

  // On the first Play of this mount, if there is a saved playback position,
  // bring the resumed paragraph into view (F5). Honors users who browse before
  // playing: the jump only fires once, and only when a position was saved.
  const autoScrolledRef = useRef(false)
  const playRef = useRef(player.play)
  playRef.current = player.play
  const handlePlay = useCallback(() => {
    if (!autoScrolledRef.current && book.position) {
      autoScrolledRef.current = true
      scrollIntoViewCenter(activeParagraphRef.current)
    }
    playRef.current()
  }, [book.position])

  // --- Outline (F2) ---
  const [outlineOpen, setOutlineOpen] = useState(false)
  // Paragraph id to briefly pulse after non-playing navigation (Outline). Cleared
  // via onAnimationEnd in ReaderView once the highlight finishes.
  const [pulseId, setPulseId] = useState<string | null>(null)
  const chapterFirstParagraphId = useMemo(() => {
    const map = new Map<number, string>()
    for (const p of cleanedParagraphs) {
      if (!map.has(p.chapterIndex)) map.set(p.chapterIndex, p.id)
    }
    return map
  }, [cleanedParagraphs])
  const currentChapterIndex = player.currentParagraph?.chapterIndex ?? null
  const handleSelectChapter = useCallback(
    (chapterIndex: number, paragraphIndex?: number) => {
      let id: string | undefined
      if (paragraphIndex !== undefined) {
        const chapter = chapters.find((c) => c.index === chapterIndex)
        if (chapter) id = `${chapter.id}:${paragraphIndex}`
      } else {
        id = chapterFirstParagraphId.get(chapterIndex)
      }
      if (id) {
        // Navigate without autoplay: position the highlight + scroll, and let
        // the user press Play when ready. A pulse makes the target obvious.
        player.navigateToParagraph(id)
        setPulseId(id)
        setTimeout(scrollToCurrent, 0)
      }
    },
    [chapters, chapterFirstParagraphId, player, scrollToCurrent],
  )

  // --- Per-paragraph transform (F8) ---
  const transform = useParagraphTransform({
    currentParagraphId: player.currentParagraphId,
    chapters,
    cleanedParagraphs,
    cleaning: settings.cleaning,
    ai: settings.ai,
    synthMode: settings.synthesizeOnUpload,
    voiceId: settings.voiceId,
    online,
    bookId: book.id,
    onParagraphChanged,
    onPause: player.pause,
  })

  // --- Whole-book generation (M13 / ADR-0012) ---
  // Subscribe to the global transform manager; filter to this book. While a
  // generation is running or paused, the reader's Play button is disabled
  // (mirrors `uploading: true`'s mobile synth lockdown) and a sticky banner
  // shows progress + Pause/Resume/Cancel.
  const transformState = useBookTransformState()
  const transformForThisBook =
    (transformState.type === 'running' ||
      transformState.type === 'paused' ||
      transformState.type === 'done' ||
      transformState.type === 'error') &&
    transformState.bookId === book.id
      ? transformState
      : null
  const generationActive = transformForThisBook?.type === 'running'
  const generation = useMemo(() => {
    if (!transformForThisBook || transformForThisBook.type !== 'running') return null
    return {
      activeChapterIndex: transformForThisBook.currentChapterIndex,
      running: true,
      opLabel: transformForThisBook.opLabel,
      chapterStartedAt: transformForThisBook.chapterStartedAt,
      streamingParagraphs: transformForThisBook.streamingParagraphs
        ? {
            opLabel: transformForThisBook.streamingParagraphs.opLabel,
            isReductive: transformForThisBook.streamingParagraphs.isReductive,
            chunkStartIndex: transformForThisBook.streamingParagraphs.chunkStartIndex,
            chunkInputCount: transformForThisBook.streamingParagraphs.chunkInputCount,
            chunkIndex: transformForThisBook.streamingParagraphs.chunkIndex,
            chunkTotal: transformForThisBook.streamingParagraphs.chunkTotal,
            paragraphs: transformForThisBook.streamingParagraphs.paragraphs,
            reasoning: transformForThisBook.streamingParagraphs.reasoning,
          }
        : null,
    }
  }, [transformForThisBook])
  const handlePauseGeneration = useCallback(() => bookTransformManager.pause(), [])
  const handleResumeGeneration = useCallback(
    () =>
      void bookTransformManager.resume(book.id, {
        ai: settings.ai ?? {
          enabled: false,
          backend: 'cloud',
          cloud: { providers: [], activeProviderId: null },
          transformDefs: [],
        },
        defs: settings.ai?.transformDefs ?? [],
        synthEnabled: settings.synthesizeOnUpload !== 'off',
      }),
    [book.id, settings.ai, settings.synthesizeOnUpload],
  )
  const handleCancelGeneration = useCallback(() => void bookTransformManager.cancel(), [])

  // Esc-to-abort: when no modal is open (modals own their own Esc handler
  // that closes them), Esc aborts either an in-flight per-paragraph stream
  // (F8) or a whole-book generation (M13). Priority is intentional — modals
  // mount their keydown listener above this one when open.
  useEffect(() => {
    if (transform.transformOpen) return
    if (!transform.stream && !generationActive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (transform.stream) transform.stopAi()
        else bookTransformManager.pause()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [transform.transformOpen, transform.stream, transform.stopAi, generationActive])

  // --- Progress persistence (debounced + unmount flush) ---
  useProgressPersistence({
    bookId: book.id,
    currentIndex: player.currentIndex,
    currentParagraph: player.currentParagraph,
    totalParagraphs: cleanedParagraphs.length,
  })

  const showFab = !!player.currentParagraphId && !activeInView

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-32 sm:space-y-6">
      {transformForThisBook && (
        <GenerationBanner
          state={transformForThisBook}
          totalChapters={cleanedChapters.length}
          onPause={handlePauseGeneration}
          onResume={handleResumeGeneration}
          onCancel={handleCancelGeneration}
        />
      )}
      <ReaderView
        book={book}
        chapters={cleanedChapters}
        currentParagraphId={player.currentParagraphId}
        onSeekParagraph={player.seekToParagraph}
        activeParagraphRef={activeParagraphRef}
        pulseParagraphId={pulseId}
        onPulseEnd={() => setPulseId(null)}
        bufferedParagraphIds={bufferedParagraphIds}
        stream={transform.stream}
        onStopStream={transform.stopAi}
        generation={generation}
      />
      <PlayerBar
        status={player.status}
        playbackRate={settings.playbackRate}
        bufferedAhead={player.bufferedAhead}
        hasCurrentParagraph={!!player.currentParagraphId}
        onPlay={handlePlay}
        onPause={player.pause}
        onStop={player.stop}
        onNext={player.next}
        onPrev={player.prev}
        onNextChapter={player.nextChapter}
        onPrevChapter={player.prevChapter}
        onRateChange={(rate) => void update({ playbackRate: rate })}
        onGoToCurrent={scrollToCurrent}
        onScrollToTop={() => scrollToTop()}
        onOpenOutline={cleanedChapters.length > 0 ? () => setOutlineOpen(true) : undefined}
        onTransformParagraph={transform.openTransform}
        synthLockdown={synthLockdown || generationActive}
        lockdownLabel={
          generationActive
            ? transformForThisBook?.type === 'running'
              ? `Generating · ${transformForThisBook.done}/${transformForThisBook.total} chapters`
              : 'Generation in progress'
            : lockdownLabel
        }
      />
      {showFab && (
        <button
          type="button"
          onClick={scrollToCurrent}
          className="fixed bottom-24 right-4 z-30 flex h-11 w-11 items-center justify-center border border-accent bg-accent text-bg shadow-lg"
          aria-label="Go to current paragraph"
        >
          <Locate className="h-5 w-5" />
        </button>
      )}
      <Outline
        open={outlineOpen}
        chapters={cleanedChapters}
        currentChapterIndex={currentChapterIndex}
        onSelect={handleSelectChapter}
        onClose={() => setOutlineOpen(false)}
        bufferedParagraphIds={bufferedParagraphIds}
      />
      <ParagraphTransformModal
        open={transform.transformOpen}
        preview={transform.targetPreview}
        aiEnabled={!!settings.ai?.enabled}
        online={online}
        aiBusy={transform.aiBusy}
        error={transform.transformError}
        canUndo={transform.undoCount > 0}
        defs={settings.ai?.transformDefs ?? []}
        onApplyAi={transform.applyAi}
        onApplyDeterministic={transform.applyDet}
        onUndo={transform.handleUndo}
        onClose={() => transform.setTransformOpen(false)}
      />
    </div>
  )
}

/** Bare `/reader` — redirect to the latest book (or the library when empty). */
function ReaderRedirect() {
  const navigate = useNavigate()
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const latest = await getMostRecentBook()
      if (cancelled) return
      navigate(latest ? `/reader/${latest.id}` : '/library', { replace: true })
    })()
    return () => {
      cancelled = true
    }
  }, [navigate])
  return <p className="text-muted">Loading…</p>
}

/** `/reader/:bookId` — load by id, render the pane. */
function ReaderLoader({ id }: { id: BookId }) {
  const navigate = useNavigate()
  const [load, setLoad] = useState<LoadState>({ type: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const book = await getBook(id)
      if (cancelled) return
      if (!book) {
        setLoad({ type: 'not-found' })
        return
      }
      const chapters = await getChaptersByBook(id)
      if (cancelled) return
      setLoad({ type: 'ready', book, chapters })
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (load.type === 'not-found') navigate('/library', { replace: true })
  }, [load, navigate])

  // --- M13: refresh chapters when bookTransformManager commits.
  //
  // The manager writes chapters to IDB after each chapter boundary
  // (`putChapters(working)` in `runLoop`). Without this effect, the reader's
  // in-memory `chapters` array is frozen at mount-time — the user never sees
  // the AI-rewritten paragraphs until they navigate away and back.
  //
  // Triggered on `state.done` increments (chapter committed) and on terminal
  // transitions (`done`/`error`). Per-token `streamingParagraphs` updates
  // are NOT a trigger — they fire at ~4/sec and would hammer IDB. The
  // in-place streaming visual is fed directly by `<ReaderView>` via the
  // `generation` prop (computed below from `transformForThisBook`).
  const transformState = useBookTransformState()
  // Stable signature: only the fields that imply a chapter commit or a
  // terminal transition. Per-token `streamingParagraphs` is intentionally
  // absent (would hammer IDB at ~4/sec). The `idle` variant has no `bookId`.
  const transformForThisBook =
    transformState.type !== 'idle' && transformState.bookId === id ? transformState : null
  const transformTick = transformForThisBook
    ? `${transformForThisBook.type}:${
        transformForThisBook.type === 'running' ? transformForThisBook.done : ''
      }`
    : 'idle'

  useEffect(() => {
    if (transformTick === 'idle') return
    let cancelled = false
    void (async () => {
      const fresh = await getChaptersByBook(id)
      if (cancelled) return
      setLoad((prev) => (prev.type === 'ready' ? { ...prev, chapters: fresh } : prev))
    })()
    return () => {
      cancelled = true
    }
  }, [transformTick, id])

  // Per-paragraph transform (F8): persist the new text and update the in-memory
  // chapters so the reader + player re-derive from the edited source.
  const handleParagraphChanged = useCallback(
    (chapterId: ChapterId, rawParagraphIndex: number, text: string) => {
      void updateParagraph(chapterId, rawParagraphIndex, text)
      setLoad((prev) =>
        prev.type === 'ready'
          ? {
              ...prev,
              chapters: prev.chapters.map((c) =>
                c.id === chapterId
                  ? {
                      ...c,
                      paragraphs: c.paragraphs.map((p, i) => (i === rawParagraphIndex ? text : p)),
                    }
                  : c,
              ),
            }
          : prev,
      )
    },
    [],
  )

  return (
    <div className="space-y-6">
      {load.type === 'loading' && <p className="text-muted">Loading…</p>}
      {load.type === 'not-found' && <p className="text-muted">Book not found.</p>}
      {load.type === 'ready' && (
        <ReaderPane
          key={load.book.id}
          book={load.book}
          chapters={load.chapters}
          onParagraphChanged={handleParagraphChanged}
        />
      )}
    </div>
  )
}

export function Reader() {
  const { bookId: idParam } = useParams<{ bookId: string }>()
  if (!idParam) return <ReaderRedirect />
  return <ReaderLoader id={bookId(idParam)} />
}

/**
 * Sticky progress banner for whole-book AI generation (M13). Renders above
 * the reader when `bookTransformManager` has an active/paused/done/error job
 * for this book. Mirrors the synth banner pattern: progress label + action
 * buttons (Pause / Resume / Cancel / Close).
 *
 * Two render modes:
 * - **Preparing** (running but no tokens received yet for the current
 *   chapter): spinner + "Waiting for first token…" + live elapsed counter.
 *   Provider first-token latency can be minutes on slow / free-tier models
 *   (z.ai glm-4.7 measured 268s on 2026-07-20) — without this state the
 *   banner would show 0% with no motion, indistinguishable from "stuck".
 * - **Streaming** (tokens flowing): `❯ {opLabel}` + chapter X/Y + N% + thin
 *   accent progress bar. Sub-chapter percentage moves visibly (intra-chunk
 *   fraction derived from `paragraphs.length / chunkInputCount`).
 */
function GenerationBanner({
  state,
  totalChapters,
  onPause,
  onResume,
  onCancel,
}: {
  state:
    | {
        type: 'running'
        done: number
        total: number
        opLabel: string
        currentChapterIndex: number
        chapterStartedAt: number
        streamingParagraphs: {
          chunkIndex: number
          chunkTotal: number
          chunkInputCount: number
          paragraphs: string[]
        } | null
      }
    | { type: 'paused'; done: number; total: number; currentOpIndex: number }
    | { type: 'done' }
    | { type: 'error'; message: string }
  totalChapters: number
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  if (state.type === 'done') return null
  if (state.type === 'error') {
    return (
      <div
        className="flex items-center gap-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm"
        data-testid="generation-banner"
      >
        <span className="flex-1 text-danger">{state.message}</span>
        <button
          type="button"
          onClick={onResume}
          className="rounded-md border border-danger px-2 py-1 text-xs uppercase tracking-[0.08em] text-danger hover:bg-danger hover:text-bg"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-danger px-2 py-1 text-xs uppercase tracking-[0.08em] text-danger hover:bg-danger hover:text-bg"
          aria-label="Cancel"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
    )
  }
  const running = state.type === 'running'
  const done = state.type === 'running' ? state.done : state.done
  const total = state.type === 'running' ? state.total : state.total
  const opLabel = state.type === 'running' ? state.opLabel : 'paused'
  const chapterIdx = state.type === 'running' ? state.currentChapterIndex : undefined
  // Intra-chunk progress: combines chunkIndex/chunkTotal (chapter-wide) with
  // paragraphs.length/chunkInputCount (within current chunk). Without this,
  // a long single-chunk chapter sits at 0% for the entire stream duration
  // (the original M13 regression — banner looked "stuck" while tokens flowed).
  const sp = state.type === 'running' ? state.streamingParagraphs : null
  const intraChunk =
    sp && sp.chunkInputCount > 0 ? Math.min(1, sp.paragraphs.length / sp.chunkInputCount) : 0
  const chunkAdjusted = sp ? sp.chunkIndex + intraChunk : 0
  const chapterFraction = sp ? chunkAdjusted / Math.max(1, sp.chunkTotal) : 0
  const fraction = total > 0 ? Math.min(1, (done + chapterFraction) / total) : 0
  // "Preparing" = running but no tokens received yet for the current chapter.
  // Provider first-token latency can be minutes on slow / free-tier models
  // (z.ai glm-4.7 measured 268s on 2026-07-20). Without an elapsed counter
  // the banner shows 0% with no motion — looks identical to "stuck/failed".
  // The spinner + elapsed seconds are the user's signal that we're waiting
  // on the provider, not the app.
  const preparing = running && (!sp || sp.paragraphs.length === 0) && state.type === 'running'
  const chapterStartedAt = state.type === 'running' ? state.chapterStartedAt : null
  return (
    <div
      className="space-y-2 rounded-md border border-accent bg-accent-soft px-3 py-2"
      data-testid="generation-banner"
    >
      <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-accent">
        {preparing ? (
          <span
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
        ) : (
          <span aria-hidden>❯</span>
        )}
        <span>{opLabel}</span>
        <span aria-hidden className="mx-1 flex-1 border-b border-dotted border-accent/40" />
        <span>
          {chapterIdx !== undefined ? `ch ${chapterIdx + 1}/${totalChapters}` : ''}
          {chapterIdx !== undefined && !preparing ? ' · ' : ''}
          {preparing ? 'waiting…' : `${Math.round(fraction * 100)}%`}
        </span>
        {running ? (
          <button
            type="button"
            onClick={onPause}
            className="inline-flex items-center gap-1 rounded-md border border-accent px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-accent hover:bg-accent hover:text-bg"
            aria-label="Pause generation"
          >
            <Pause className="h-2.5 w-2.5 fill-current" aria-hidden />
            Pause
          </button>
        ) : (
          <button
            type="button"
            onClick={onResume}
            className="inline-flex items-center gap-1 rounded-md border border-accent px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-accent hover:bg-accent hover:text-bg"
            aria-label="Resume generation"
          >
            <Play className="h-2.5 w-2.5 fill-current" aria-hidden />
            Resume
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md border border-accent px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-accent hover:bg-accent hover:text-bg"
          aria-label="Cancel generation"
        >
          <X className="h-2.5 w-2.5" aria-hidden />
          Cancel
        </button>
      </div>
      {preparing && chapterStartedAt !== null ? (
        // Preparing sub-status: elapsed counter + "waiting for first token"
        // hint. Provider first-token latency can be minutes — the visible
        // counter is the user's signal that we're waiting on the network,
        // not the app being broken.
        <div
          className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-accent/70"
          data-testid="preparing-status"
        >
          <span>waiting for first token</span>
          <span aria-hidden>·</span>
          <PreparingElapsedTimer startedAt={chapterStartedAt} />
        </div>
      ) : (
        // Thin progress bar — only meaningful once tokens are flowing.
        // During preparing it would just show 0% and look frozen.
        <div className="h-1 w-full overflow-hidden rounded-full bg-accent/20" aria-hidden>
          <div
            className="h-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      )}
    </div>
  )
}
