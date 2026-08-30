import { Locate } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useDatasource } from '../../context/datasource'
import { useSettings } from '../../context/settings'
import { useIsMobile } from '../../hooks/useIsMobile'
import { cleanChapters } from '../../lib/clean'
import { scrollIntoViewCenter, scrollToTop } from '../../lib/scroll'
import { unavailableEngine } from '../../lib/tts/unavailable'
import { type Book, type BookId, type BookPosition, bookId, type Chapter } from '../../types'
import { Outline } from './Outline'
import { PlayerBar } from './PlayerBar'
import { flattenParagraphs } from './players/types'
import { usePlayer } from './players/usePlayer'
import { ReaderView } from './ReaderView'
import { useCachedParagraphs } from './useCachedParagraphs'
import { useElementVisible } from './useElementVisible'
import { useMediaSession } from './useMediaSession'
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
  | { type: 'error'; message: string }
  | { type: 'ready'; book: Book; chapters: Chapter[] }

/**
 * Playback view for a loaded book — owns the player hook (keyed by book.id).
 *
 * Post-pivot (ADR-0015): audio arrives with the imported `.taletrek` bundle,
 * keyed under the book's own voice. Lookups (`useCachedParagraphs` + the
 * players) therefore use `book.voiceId`, and the engine slot carries the
 * unavailable stub — a cache miss surfaces an error instead of synthesizing.
 */
function ReaderPane({ book, chapters }: { book: Book; chapters: Chapter[] }) {
  const { settings, update } = useSettings()
  const cleanedChapters = useMemo(
    () => cleanChapters(chapters, settings.cleaning),
    [chapters, settings.cleaning],
  )
  const cleanedParagraphs = useMemo(() => flattenParagraphs(cleanedChapters), [cleanedChapters])
  const isMobile = useIsMobile()
  // The voice the book's audio lives under: the bundle's voice when present
  // (set at import), else the stored default (legacy pre-pivot books).
  const playbackVoiceId = book.voiceId ?? settings.voiceId

  // Which paragraphs have audio in the persistent cache (drives the reader's
  // buffered dots + the players' lookups). Keyed on the playback voice —
  // the voice the audio was synthesized under.
  const cachedIds = useCachedParagraphs(book.id, playbackVoiceId, cleanedChapters, 0)

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
      voiceId: playbackVoiceId,
      playbackRate: settings.playbackRate,
      engine: unavailableEngine,
      initialIndex,
      bookId: book.id,
    },
    { isMobile },
  )
  useMediaSession({
    player,
    bookTitle: book.title,
    chapters: cleanedChapters,
    playbackRate: settings.playbackRate,
  })

  // --- Scroll-to-current infrastructure ---
  const activeParagraphRef = useRef<HTMLParagraphElement | null>(null)
  const activeInView = useElementVisible(activeParagraphRef, player.currentParagraphId)
  const scrollToCurrent = useCallback(() => scrollIntoViewCenter(activeParagraphRef.current), [])

  // On the first Play of this mount, if there is a saved playback position,
  // bring the resumed paragraph into view. Honors users who browse before
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

  // --- Progress persistence (debounced + unmount flush) ---
  useProgressPersistence({
    bookId: book.id,
    currentIndex: player.currentIndex,
    currentParagraph: player.currentParagraph,
    totalParagraphs: cleanedParagraphs.length,
  })

  const showFab = !!player.currentParagraphId && !activeInView

  return (
    <>
      <div className="mx-auto max-w-3xl space-y-4 pb-32 sm:space-y-6">
        <ReaderView
          book={book}
          chapters={cleanedChapters}
          currentParagraphId={player.currentParagraphId}
          onSeekParagraph={player.seekToParagraph}
          activeParagraphRef={activeParagraphRef}
          pulseParagraphId={pulseId}
          onPulseEnd={() => setPulseId(null)}
          bufferedParagraphIds={cachedIds}
        />
      </div>
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
      />
      <Outline
        open={outlineOpen}
        chapters={cleanedChapters}
        currentChapterIndex={currentChapterIndex}
        onSelect={handleSelectChapter}
        onClose={() => setOutlineOpen(false)}
        bufferedParagraphIds={cachedIds}
      />
    </>
  )
}

/** Bare `/reader` — redirect to the latest book (or the library when empty). */
function ReaderRedirect() {
  const navigate = useNavigate()
  const { library } = useDatasource()
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const latest = await library.getMostRecentBook()
      if (cancelled) return
      navigate(latest ? `/reader/${latest.id}` : '/library', { replace: true })
    })()
    return () => {
      cancelled = true
    }
  }, [navigate, library])
  return <p className="text-muted">Loading…</p>
}

/** `/reader/:bookId` — load by id, render the pane. */
function ReaderLoader({ id }: { id: BookId }) {
  const navigate = useNavigate()
  const { library } = useDatasource()
  const [load, setLoad] = useState<LoadState>({ type: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const book = await library.getBook(id)
        if (cancelled) return
        if (!book) {
          setLoad({ type: 'not-found' })
          return
        }
        const chapters = await library.getChaptersByBook(id)
        if (cancelled) return
        setLoad({ type: 'ready', book, chapters })
      } catch (e) {
        setLoad({
          type: 'error',
          message: e instanceof Error ? e.message : 'Failed to load book',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, library])

  useEffect(() => {
    if (load.type === 'not-found') navigate('/library', { replace: true })
  }, [load, navigate])

  return (
    <div className="space-y-6">
      {load.type === 'loading' && <p className="text-muted">Loading…</p>}
      {load.type === 'not-found' && <p className="text-muted">Book not found.</p>}
      {load.type === 'error' && (
        <div role="alert" className="border border-danger bg-danger/10 p-4 text-danger">
          <p className="text-sm font-medium">Couldn't load this book.</p>
          <p className="mt-1 text-sm">{load.message}</p>
        </div>
      )}
      {load.type === 'ready' && (
        <ReaderPane key={load.book.id} book={load.book} chapters={load.chapters} />
      )}
    </div>
  )
}

export function Reader() {
  const { bookId: idParam } = useParams<{ bookId: string }>()
  if (!idParam) return <ReaderRedirect />
  return <ReaderLoader id={bookId(idParam)} />
}
