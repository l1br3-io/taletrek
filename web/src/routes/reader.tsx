import { Locate } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Outline } from '../components/Outline'
import { ParagraphTransformModal } from '../components/ParagraphTransformModal'
import { PlayerBar } from '../components/PlayerBar'
import { ReaderView } from '../components/ReaderView'
import { useSettings } from '../context/settings'
import { useElementVisible } from '../hooks/useElementVisible'
import { useMediaSession } from '../hooks/useMediaSession'
import {
  flattenParagraphs,
  type ParagraphRef,
  useParagraphPlayer,
} from '../hooks/useParagraphPlayer'
import { getAiEngine } from '../lib/ai/client'
import type { TransformOp } from '../lib/ai/types'
import { cleanChapters, cleanParagraphsWithOrigins } from '../lib/clean'
import {
  getBook,
  getChaptersByBook,
  getMostRecentBook,
  updateBookProgress,
  updateParagraph,
} from '../lib/db'
import { scrollIntoViewCenter, scrollToTop } from '../lib/scroll'
import { applyDeterministicOp, type DeterministicOp } from '../lib/transforms/deterministic'
import { ttsClient } from '../lib/tts/client'
import {
  type Book,
  type BookId,
  type BookPosition,
  bookId,
  type Chapter,
  type ChapterId,
} from '../types'

type LoadState =
  | { type: 'loading' }
  | { type: 'not-found' }
  | { type: 'ready'; book: Book; chapters: Chapter[] }

/** Resolve a saved position to a flat index into the cleaned paragraph stream. */
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

function toPosition(p: ParagraphRef): BookPosition {
  return { chapterIndex: p.chapterIndex, paragraphIndex: p.paragraphIndex }
}

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
  const cleanedChapters = useMemo(
    () => cleanChapters(chapters, settings.cleaning),
    [chapters, settings.cleaning],
  )
  const cleanedParagraphs = useMemo(() => flattenParagraphs(cleanedChapters), [cleanedChapters])

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
  // Transforms edit the RAW source paragraph (source of truth); cleaning
  // re-derives the displayed text. The cleaned→raw mapping comes from
  // `cleanParagraphsWithOrigins`, which mirrors the read-time cleaning exactly.
  const [transformOpen, setTransformOpen] = useState(false)
  const [transformError, setTransformError] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const undoStackRef = useRef<
    Array<{ chapterId: ChapterId; rawParagraphIndex: number; prevText: string }>
  >([])

  const targetId = player.currentParagraphId
  const targetPreview = useMemo(() => {
    if (!targetId) return ''
    return cleanedParagraphs.find((p) => p.id === targetId)?.text ?? ''
  }, [targetId, cleanedParagraphs])

  const resolveTarget = useCallback(() => {
    if (!targetId) return null
    const sep = targetId.lastIndexOf(':')
    const chapterIdStr = targetId.slice(0, sep)
    const cleanedIdx = Number(targetId.slice(sep + 1))
    const chapter = chapters.find((c) => c.id === chapterIdStr)
    if (!chapter) return null
    const origin = cleanParagraphsWithOrigins(chapter.paragraphs, settings.cleaning)[cleanedIdx]
    if (!origin) return null
    return {
      chapterId: chapter.id,
      rawParagraphIndex: origin.rawIndex,
      rawText: chapter.paragraphs[origin.rawIndex] ?? '',
    }
  }, [targetId, chapters, settings.cleaning])

  // Auto re-synth: when a paragraph is transformed (F8) and synth mode is not
  // 'off', fire-and-forget a synthesis of the new text so the cache stays
  // populated for the power-user flow. Silent + best-effort — the engine
  // swallows cache-write failures, and the next play will hit the cache if the
  // synth has completed or re-synthesize on demand if not.
  const resynthParagraph = useCallback(
    (text: string) => {
      if (settings.synthesizeOnUpload === 'off') return
      if (!text.trim()) return
      void ttsClient.synthesize({ text, voiceId: settings.voiceId, bookId: book.id })
    },
    [settings.synthesizeOnUpload, settings.voiceId, book.id],
  )

  const commitTransform = useCallback(
    (chapterId: ChapterId, rawParagraphIndex: number, prevText: string, nextText: string) => {
      if (nextText === prevText) return
      undoStackRef.current.push({ chapterId, rawParagraphIndex, prevText })
      setUndoCount(undoStackRef.current.length)
      onParagraphChanged(chapterId, rawParagraphIndex, nextText)
      resynthParagraph(nextText)
    },
    [onParagraphChanged, resynthParagraph],
  )

  const applyDet = useCallback(
    (op: DeterministicOp) => {
      setTransformError(null)
      const target = resolveTarget()
      if (!target) {
        setTransformError('No paragraph selected — tap a paragraph first.')
        return
      }
      commitTransform(
        target.chapterId,
        target.rawParagraphIndex,
        target.rawText,
        applyDeterministicOp(target.rawText, op),
      )
    },
    [resolveTarget, commitTransform],
  )

  const applyAi = useCallback(
    async (op: TransformOp) => {
      setTransformError(null)
      const target = resolveTarget()
      if (!target) {
        setTransformError('No paragraph selected — tap a paragraph first.')
        return
      }
      if (!settings.ai?.enabled) {
        setTransformError('Enable AI transforms in Settings first.')
        return
      }
      setAiBusy(true)
      try {
        const engine = getAiEngine(settings.ai)
        if (!engine) {
          throw new Error('No cloud provider configured — add one in Settings.')
        }
        const ready = await engine.isReady()
        if (!ready) {
          throw new Error(
            'AI engine is not ready — load the model or set your API key in Settings.',
          )
        }
        const [out] = await engine.transform([target.rawText], op)
        if (!out?.trim()) throw new Error('AI returned an empty result.')
        commitTransform(target.chapterId, target.rawParagraphIndex, target.rawText, out.trim())
      } catch (e) {
        setTransformError(e instanceof Error ? e.message : 'AI transform failed.')
      } finally {
        setAiBusy(false)
      }
    },
    [resolveTarget, commitTransform, settings.ai],
  )

  const handleUndo = useCallback(() => {
    const last = undoStackRef.current.pop()
    if (!last) return
    setUndoCount(undoStackRef.current.length)
    onParagraphChanged(last.chapterId, last.rawParagraphIndex, last.prevText)
    resynthParagraph(last.prevText)
  }, [onParagraphChanged, resynthParagraph])

  const openTransform = useCallback(() => {
    setTransformError(null)
    player.pause()
    setTransformOpen(true)
  }, [player.pause])

  // Debounced progress persistence: write at most once per ~2s of movement, and
  // flush the final position on unmount. `latestRef` holds the most recent pos.
  const latestRef = useRef<{ position: BookPosition; fraction: number } | null>(null)
  useEffect(() => {
    const idx = player.currentIndex
    const para = player.currentParagraph
    if (idx === null || para === null) return
    const total = cleanedParagraphs.length
    const fraction = total > 0 ? (idx + 1) / total : 0
    latestRef.current = { position: toPosition(para), fraction }
    const handle = setTimeout(() => {
      if (latestRef.current) {
        void updateBookProgress(book.id, latestRef.current.position, latestRef.current.fraction)
      }
    }, 2000)
    return () => clearTimeout(handle)
  }, [player.currentIndex, player.currentParagraph, book.id, cleanedParagraphs.length])

  useEffect(() => {
    return () => {
      if (latestRef.current) {
        void updateBookProgress(book.id, latestRef.current.position, latestRef.current.fraction)
      }
    }
  }, [book.id])

  const showFab = !!player.currentParagraphId && !activeInView

  return (
    <div className="space-y-6">
      <ReaderView
        book={book}
        chapters={cleanedChapters}
        currentParagraphId={player.currentParagraphId}
        onSeekParagraph={player.seekToParagraph}
        activeParagraphRef={activeParagraphRef}
        pulseParagraphId={pulseId}
        onPulseEnd={() => setPulseId(null)}
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
        onTransformParagraph={openTransform}
      />
      {showFab && (
        <button
          type="button"
          onClick={scrollToCurrent}
          className="fixed bottom-24 right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-accent text-bg shadow-lg"
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
      />
      <ParagraphTransformModal
        open={transformOpen}
        preview={targetPreview}
        aiEnabled={!!settings.ai?.enabled}
        aiBusy={aiBusy}
        error={transformError}
        canUndo={undoCount > 0}
        onApplyAi={applyAi}
        onApplyDeterministic={applyDet}
        onUndo={handleUndo}
        onClose={() => setTransformOpen(false)}
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
