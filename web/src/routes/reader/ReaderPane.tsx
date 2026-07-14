import { Locate } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useSettings } from '../../context/settings'
import { useOnline } from '../../hooks/useOnline'
import { cleanChapters } from '../../lib/clean'
import { getBook, getChaptersByBook, getMostRecentBook, updateParagraph } from '../../lib/db'
import { scrollIntoViewCenter, scrollToTop } from '../../lib/scroll'
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
import { ReaderView } from './ReaderView'
import { useCachedParagraphs } from './useCachedParagraphs'
import { useElementVisible } from './useElementVisible'
import { useMediaSession } from './useMediaSession'
import { flattenParagraphs, useParagraphPlayer } from './useParagraphPlayer'
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

  const player = useParagraphPlayer({
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
  })
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

  // --- Progress persistence (debounced + unmount flush) ---
  useProgressPersistence({
    bookId: book.id,
    currentIndex: player.currentIndex,
    currentParagraph: player.currentParagraph,
    totalParagraphs: cleanedParagraphs.length,
  })

  const showFab = !!player.currentParagraphId && !activeInView

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <ReaderView
        book={book}
        chapters={cleanedChapters}
        currentParagraphId={player.currentParagraphId}
        onSeekParagraph={player.seekToParagraph}
        activeParagraphRef={activeParagraphRef}
        pulseParagraphId={pulseId}
        onPulseEnd={() => setPulseId(null)}
        bufferedParagraphIds={bufferedParagraphIds}
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
