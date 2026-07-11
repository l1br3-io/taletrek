import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { PlayerBar } from '../components/PlayerBar'
import { ReaderView } from '../components/ReaderView'
import { UploadButton } from '../components/UploadButton'
import { useSettings } from '../context/settings'
import { useMediaSession } from '../hooks/useMediaSession'
import {
  flattenParagraphs,
  type ParagraphRef,
  useParagraphPlayer,
} from '../hooks/useParagraphPlayer'
import { cleanChapters } from '../lib/clean'
import { getBook, getChaptersByBook, getMostRecentBook, updateBookProgress } from '../lib/db'
import { ingestBook } from '../lib/ingest'
import { formatForFile } from '../lib/parse/util'
import { ttsClient } from '../lib/tts/client'
import { type Book, type BookId, type BookPosition, bookId, type Chapter } from '../types'

type LoadState =
  | { type: 'loading' }
  | { type: 'not-found' }
  | { type: 'ready'; book: Book; chapters: Chapter[] }

type UploadState =
  | { type: 'idle' }
  | { type: 'parsing'; fileName: string }
  | { type: 'error'; message: string }

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
function ReaderPane({ book, chapters }: { book: Book; chapters: Chapter[] }) {
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
  })
  useMediaSession({
    player,
    bookTitle: book.title,
    chapters: cleanedChapters,
    playbackRate: settings.playbackRate,
  })

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

  return (
    <div className="space-y-6">
      <ReaderView
        book={book}
        chapters={cleanedChapters}
        currentParagraphId={player.currentParagraphId}
        onSeekParagraph={player.seekToParagraph}
      />
      <PlayerBar
        status={player.status}
        playbackRate={settings.playbackRate}
        bufferedAhead={player.bufferedAhead}
        onPlay={player.play}
        onPause={player.pause}
        onStop={player.stop}
        onNext={player.next}
        onPrev={player.prev}
        onNextChapter={player.nextChapter}
        onPrevChapter={player.prevChapter}
        onRateChange={(rate) => void update({ playbackRate: rate })}
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

/** `/reader/:bookId` — load by id, handle upload, render the pane. */
function ReaderLoader({ id }: { id: BookId }) {
  const navigate = useNavigate()
  const [load, setLoad] = useState<LoadState>({ type: 'loading' })
  const [upload, setUpload] = useState<UploadState>({ type: 'idle' })

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

  const handleSelect = useCallback(
    async (file: File): Promise<void> => {
      if (!formatForFile(file.name)) {
        setUpload({ type: 'error', message: `Unsupported file type: ${file.name}` })
        return
      }
      setUpload({ type: 'parsing', fileName: file.name })
      try {
        const { book } = await ingestBook(file)
        setUpload({ type: 'idle' })
        navigate(`/reader/${book.id}`, { replace: true })
      } catch (error) {
        setUpload({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to parse file',
        })
      }
    },
    [navigate],
  )

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <UploadButton onSelect={handleSelect} disabled={upload.type === 'parsing'} />
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

      {load.type === 'loading' && <p className="text-muted">Loading…</p>}
      {load.type === 'not-found' && <p className="text-muted">Book not found.</p>}
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
