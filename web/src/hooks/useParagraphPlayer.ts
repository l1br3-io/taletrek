import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TtsEngine } from '../lib/tts/types'
import type { BookId, Chapter, VoiceId } from '../types'

/** Default look-ahead depth: paragraphs pre-rendered ahead of the pointer. */
const DEFAULT_LOOKAHEAD = 8

/** A flattened, stable reference to a single paragraph within a book. */
export interface ParagraphRef {
  /** `${chapterId}:${paragraphIndex}` — stable across renders. */
  id: string
  chapterId: Chapter['id']
  chapterIndex: number
  paragraphIndex: number
  text: string
}

export type PlaybackStatus =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'buffering' }
  | { type: 'playing'; paragraphId: string }
  | { type: 'paused'; paragraphId: string }
  | { type: 'ended' }
  | { type: 'error'; message: string }

/** A pre-rendered audio chunk cached ahead of the playback pointer. */
interface PrerenderedChunk {
  blob: Blob
  /** Flat index into the paragraph list (for pruning + depth accounting). */
  index: number
}

/**
 * Injectable audio boundary so the hook (and its tests) never touch a real
 * `<audio>` element directly. The production impl wraps `new Audio()`.
 */
export interface AudioController {
  loadAndPlay(blob: Blob): Promise<void>
  resume(): Promise<void>
  pause(): void
  stop(): void
  setPlaybackRate(rate: number): void
  /** Register an `ended` handler; returns an unsubscribe. */
  onEnded(handler: () => void): () => void
  /** Seek relatively within the current media (clamped to [0, duration]). */
  seekBy(deltaSeconds: number): void
  /** Seek to an absolute time within the current media. */
  seekTo(seconds: number): void
  /** Current playback position within the current media, in seconds. */
  readonly currentTime: number
  /** Duration of the current media, in seconds (0 if unknown). */
  readonly duration: number
}

/** Create a real `AudioController` backed by an off-DOM `HTMLAudioElement`. */
export function createAudioController(): AudioController {
  const el = new Audio()
  el.preload = 'auto'
  el.setAttribute('playsinline', '')
  el.setAttribute('webkit-playsinline', '')
  let currentUrl: string | null = null

  return {
    async loadAndPlay(blob: Blob) {
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      const wav = blob.type === 'audio/wav' ? blob : new Blob([blob], { type: 'audio/wav' })
      currentUrl = URL.createObjectURL(wav)
      el.src = currentUrl
      if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await new Promise<void>((resolve) => {
          const onReady = () => {
            el.removeEventListener('canplay', onReady)
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(() => {
            el.removeEventListener('canplay', onReady)
            resolve()
          }, 2000)
          el.addEventListener('canplay', onReady, { once: true })
        })
      }
      await el.play()
    },
    async resume() {
      await el.play()
    },
    pause() {
      el.pause()
    },
    stop() {
      el.pause()
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      currentUrl = null
      el.removeAttribute('src')
      el.load()
    },
    setPlaybackRate(rate: number) {
      el.playbackRate = rate
    },
    onEnded(handler: () => void) {
      el.addEventListener('ended', handler)
      return () => el.removeEventListener('ended', handler)
    },
    seekBy(deltaSeconds: number) {
      const max = Number.isFinite(el.duration) ? el.duration : Infinity
      el.currentTime = Math.max(0, Math.min(max, el.currentTime + deltaSeconds))
    },
    seekTo(seconds: number) {
      const max = Number.isFinite(el.duration) ? el.duration : seconds
      el.currentTime = Math.max(0, Math.min(max, seconds))
    },
    get currentTime() {
      return el.currentTime || 0
    },
    get duration() {
      return Number.isFinite(el.duration) ? el.duration : 0
    },
  }
}

export interface UseParagraphPlayerArgs {
  chapters: Chapter[]
  voiceId: VoiceId
  playbackRate: number
  engine: TtsEngine
  /** Look-ahead depth (paragraphs pre-rendered ahead). Defaults to 3. */
  lookahead?: number
  /** Test override; defaults to a real `AudioController`. */
  audio?: AudioController
  /**
   * Flat paragraph index to seed the pointer with on mount (resume). No
   * playback is started; only the highlight + pointer are positioned so the
   * first `play()` begins here. Ignored after mount.
   */
  initialIndex?: number
  /**
   * Optional book id, threaded through to `engine.synthesize` so cached audio
   * can be cascade-cleared with `deleteBookCascade` (M8). When omitted, audio
   * is still cached but only LRU-reapable.
   */
  bookId?: BookId
  /**
   * True while a background synth job (upload manager) is running for this
   * book. When active, `primeAhead` is skipped (the background job fills the
   * cache) and the status shows 'buffering' instead of 'loading' for
   * paragraphs the background job hasn't reached yet.
   */
  backgroundActive?: boolean
  /** Paragraph ids already synthesized by the background job (for status). */
  backgroundBufferedIds?: Set<string>
  /**
   * Paragraph ids known to be in the persistent audio cache (M8). When a
   * paragraph is in this set, `playIndex` skips the 'loading'/'buffering'
   * status — the engine returns from IDB in milliseconds, so flashing a
   * loading indicator is unnecessary and jarring.
   */
  cachedParagraphIds?: Set<string>
  /**
   * Fired after each successful synthesis (on-demand or look-ahead). The
   * caller can use this to update cache-aware indicators (dots/bars) without
   * re-probing IndexedDB.
   */
  onParagraphSynthesized?: (paragraphId: string) => void
}

export interface UseParagraphPlayerResult {
  status: PlaybackStatus
  currentParagraphId: string | null
  /** The paragraph at the pointer, or null when idle (M5). */
  currentParagraph: ParagraphRef | null
  /** Flat index of the pointer, or null when idle (M5). */
  currentIndex: number | null
  /** Chunks currently buffered ahead of the pointer (0..lookahead). */
  bufferedAhead: number
  play: () => void
  pause: () => void
  stop: () => void
  /** Jump to the next paragraph (cancels in-flight pre-render). */
  next: () => void
  /** Jump to the previous paragraph (cancels in-flight pre-render). */
  prev: () => void
  /** Jump to the first paragraph of the next chapter. */
  nextChapter: () => void
  /** Jump to the first paragraph of the previous chapter. */
  prevChapter: () => void
  seekToParagraph: (id: string) => void
  /**
   * Reposition the pointer to `id` WITHOUT starting playback. Cancels any
   * in-flight playback, positions the highlight, and pre-renders ahead so the
   * next `play()` begins here instantly. Used for non-disruptive navigation
   * (e.g. tapping an Outline entry).
   */
  navigateToParagraph: (id: string) => void
  /** Seek relatively within the current paragraph (Media Session ±15s). */
  seekBy: (deltaSeconds: number) => void
  /** Seek absolutely within the current paragraph (Media Session seekto). */
  seekTo: (seconds: number) => void
  /** Read the audio element's position (Media Session position state). */
  getAudioPosition: () => { currentTime: number; duration: number }
}

/** Flatten chapters into a stable paragraph list (memoized by the caller). */
export function flattenParagraphs(chapters: readonly Chapter[]): ParagraphRef[] {
  return chapters.flatMap((chapter) =>
    chapter.paragraphs.map((text, paragraphIndex) => ({
      id: `${chapter.id}:${paragraphIndex}`,
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      paragraphIndex,
      text,
    })),
  )
}

/**
 * Pre-rendering paragraph player. Synthesizes the current paragraph via
 * `engine` and plays it through a single `<audio>` element, while
 * pre-rendering `lookahead` paragraphs ahead into an in-memory queue so the
 * next chunk is ready before the current one ends (gapless, background-safe).
 *
 * On any discontinuous pointer move (`next`/`prev`/`seekToParagraph`/
 * `nextChapter`/`prevChapter`/`stop`), in-flight pre-rendering is cancelled
 * and the queue is re-prime around the new position. Sequential `ended`
 * advance pulls the next chunk from the buffer (no synth stall).
 *
 * The caller should mount this hook behind a `key={book.id}` so switching books
 * remounts and resets playback state. Revokes the live Blob URL on advance and
 * unmount; prunes queued Blobs outside the look-ahead window.
 */
export function useParagraphPlayer({
  chapters,
  voiceId,
  playbackRate,
  engine,
  lookahead = DEFAULT_LOOKAHEAD,
  audio,
  initialIndex,
  bookId,
  backgroundActive = false,
  backgroundBufferedIds,
  cachedParagraphIds,
  onParagraphSynthesized,
}: UseParagraphPlayerArgs): UseParagraphPlayerResult {
  const paragraphs = useMemo(() => flattenParagraphs(chapters), [chapters])
  const la = Math.max(0, Math.trunc(lookahead))

  const [status, setStatus] = useState<PlaybackStatus>({ type: 'idle' })
  const [currentParagraphId, setCurrentParagraphId] = useState<string | null>(() => {
    if (initialIndex === undefined || initialIndex <= 0) return null
    return paragraphs[initialIndex]?.id ?? null
  })
  const [bufferedAhead, setBufferedAhead] = useState(0)

  // Refs for values that must NOT trigger re-subscription when they change:
  // engine + voiceId + bookId affect only the *next* synthesis, not in-flight playback.
  const engineRef = useRef(engine)
  const voiceIdRef = useRef(voiceId)
  const bookIdRef = useRef(bookId)
  const backgroundActiveRef = useRef(backgroundActive)
  const backgroundBufferedIdsRef = useRef(backgroundBufferedIds)
  const cachedParagraphIdsRef = useRef(cachedParagraphIds)
  const onSynthRef = useRef(onParagraphSynthesized)
  engineRef.current = engine
  voiceIdRef.current = voiceId
  bookIdRef.current = bookId
  backgroundActiveRef.current = backgroundActive
  backgroundBufferedIdsRef.current = backgroundBufferedIds
  cachedParagraphIdsRef.current = cachedParagraphIds
  onSynthRef.current = onParagraphSynthesized

  const pointerRef = useRef(initialIndex ?? 0)
  const tokenRef = useRef(0) // bumped on every play request; stale play results ignored
  const genRef = useRef(0) // bumped on discontinuous moves; stale pre-render results ignored
  const statusRef = useRef<PlaybackStatus>({ type: 'idle' })
  statusRef.current = status

  const audioRef = useRef<AudioController>(audio ?? createAudioController())
  const queueRef = useRef<Map<string, PrerenderedChunk>>(new Map())
  // True while a `playIndex` call is mid-flight (synthesizing or swapping the
  // `<audio>` src). Suppresses spurious `ended` events that browsers can fire
  // when `src` changes mid-loading — without this, a buffered (gapless) advance
  // stays in the 'playing' state and a spurious `ended` slips past the status
  // guard, skipping a paragraph (heard as the reader "reading too fast").
  const advancingRef = useRef(false)
  const resumeInFlightRef = useRef(false)

  const syncBufferedAhead = useCallback(() => {
    const ptr = pointerRef.current
    let count = 0
    for (const chunk of queueRef.current.values()) {
      if (chunk.index > ptr && chunk.index <= ptr + la) count++
    }
    setBufferedAhead(count)
  }, [la])

  // Drop queued chunks outside [fromIndex, fromIndex + lookahead].
  const prune = useCallback(
    (fromIndex: number) => {
      const max = fromIndex + la
      for (const [id, chunk] of queueRef.current) {
        if (chunk.index < fromIndex || chunk.index > max) {
          queueRef.current.delete(id)
        }
      }
    },
    [la],
  )

  // Pre-render paragraphs [fromIndex, fromIndex + lookahead) into the queue.
  // Sequential; checks the generation token between synth calls so a
  // discontinuous move cancels the remainder.
  const primeAhead = useCallback(
    async (fromIndex: number) => {
      const gen = genRef.current
      const to = Math.min(fromIndex + la, paragraphs.length)
      for (let i = fromIndex; i < to; i++) {
        if (gen !== genRef.current) return
        const para = paragraphs[i]
        if (!para || queueRef.current.has(para.id)) continue
        try {
          const result = await engineRef.current.synthesize({
            text: para.text,
            voiceId: voiceIdRef.current,
            ...(bookIdRef.current !== undefined ? { bookId: bookIdRef.current } : {}),
          })
          if (gen !== genRef.current) return
          queueRef.current.set(para.id, { blob: result.audio, index: i })
          onSynthRef.current?.(para.id)
          syncBufferedAhead()
        } catch {
          // Pre-render failures are non-fatal: the chunk will be synthesized
          // on demand when (if) the pointer reaches it.
          if (gen !== genRef.current) return
        }
      }
    },
    [paragraphs, la, syncBufferedAhead],
  )

  // Synthesize (or pull from the buffer) the paragraph at `index` and play it.
  const playIndex = useCallback(
    async (index: number) => {
      const para = paragraphs[index]
      if (!para) return
      const token = ++tokenRef.current
      pointerRef.current = index
      setCurrentParagraphId(para.id)
      prune(index)
      advancingRef.current = true
      try {
        const buffered = queueRef.current.get(para.id)
        if (!buffered) {
          const bgHas = backgroundBufferedIdsRef.current?.has(para.id) ?? false
          const persistentHas = cachedParagraphIdsRef.current?.has(para.id) ?? false
          const isCached = bgHas || persistentHas
          if (!isCached) {
            setStatus({ type: 'loading' })
          }
          try {
            const result = await engineRef.current.synthesize({
              text: para.text,
              voiceId: voiceIdRef.current,
              ...(bookIdRef.current !== undefined ? { bookId: bookIdRef.current } : {}),
            })
            if (token !== tokenRef.current) return
            queueRef.current.set(para.id, { blob: result.audio, index })
            onSynthRef.current?.(para.id)
          } catch (error) {
            if (token !== tokenRef.current) return
            setStatus({
              type: 'error',
              message: error instanceof Error ? error.message : 'synthesis failed',
            })
            return
          }
        }

        if (token !== tokenRef.current) return
        const chunk = queueRef.current.get(para.id)
        if (!chunk) return
        try {
          await audioRef.current.loadAndPlay(chunk.blob)
        } catch (error) {
          if (token !== tokenRef.current) return
          if (
            error instanceof DOMException &&
            (error.name === 'NotAllowedError' || error.name === 'NotSupportedError')
          ) {
            // iOS Safari: play() was called outside a user gesture (synthesis
            // or the canplay wait broke the gesture chain), or the media
            // engine wasn't ready yet. The audio IS loaded now — set status
            // to 'paused' so the next Play tap calls resume() → el.play()
            // synchronously within the gesture, with media already decoded.
            setStatus({ type: 'paused', paragraphId: para.id })
            return
          }
          setStatus({
            type: 'error',
            message: error instanceof Error ? error.message : 'playback failed',
          })
          return
        }
        if (token !== tokenRef.current) return
        setStatus({ type: 'playing', paragraphId: para.id })
        syncBufferedAhead()
        void primeAhead(index + 1)
      } finally {
        if (token === tokenRef.current) advancingRef.current = false
      }
    },
    [paragraphs, primeAhead, prune, syncBufferedAhead],
  )

  // Discontinuous move: cancel in-flight pre-render, then play the target.
  const jumpTo = useCallback(
    (index: number) => {
      genRef.current++
      void playIndex(index)
    },
    [playIndex],
  )

  // Auto-advance on `ended`. Guarded: a spurious `ended` can fire when we set a
  // new `src` mid-loading. Only advance from a genuine 'playing' state, and
  // never while an advance is already in flight (see `advancingRef`).
  // Sequential advance does NOT bump the generation — the buffer is preserved.
  useEffect(() => {
    const unsubscribe = audioRef.current.onEnded(() => {
      if (advancingRef.current) return
      if (statusRef.current.type !== 'playing') return
      const nextIndex = pointerRef.current + 1
      if (nextIndex < paragraphs.length) {
        void playIndex(nextIndex)
      } else {
        setStatus({ type: 'ended' })
      }
    })
    return unsubscribe
  }, [paragraphs, playIndex])

  // Apply playbackRate live.
  useEffect(() => {
    audioRef.current.setPlaybackRate(playbackRate)
  }, [playbackRate])

  // Voice change: invalidate the buffer (ahead chunks are the old voice) so the
  // next paragraph synthesized uses the new voice. Playback is not interrupted.
  const prevVoiceRef = useRef(voiceId)
  useEffect(() => {
    if (prevVoiceRef.current === voiceId) return
    prevVoiceRef.current = voiceId
    genRef.current++
    queueRef.current.clear()
    syncBufferedAhead()
  }, [voiceId, syncBufferedAhead])

  // Chapters change (e.g. cleaning toggled): invalidate the buffer so stale
  // chunks synthesized from the old text are not served. Playback is not
  // interrupted; the next advance re-synthesizes with the new text.
  const prevParagraphsRef = useRef(paragraphs)
  useEffect(() => {
    if (prevParagraphsRef.current === paragraphs) return
    prevParagraphsRef.current = paragraphs
    genRef.current++
    queueRef.current.clear()
    syncBufferedAhead()
  }, [paragraphs, syncBufferedAhead])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      audioRef.current.stop()
      queueRef.current.clear()
      genRef.current++
      tokenRef.current++
    }
  }, [])

  const play = useCallback(async () => {
    const s = statusRef.current
    if (s.type === 'paused') {
      if (resumeInFlightRef.current) return
      resumeInFlightRef.current = true
      try {
        await audioRef.current.resume()
        setStatus({ type: 'playing', paragraphId: s.paragraphId })
      } catch {
        setStatus({
          type: 'error',
          message: 'Tap the Play button to start playback',
        })
      } finally {
        resumeInFlightRef.current = false
      }
      return
    }
    if (s.type === 'idle' || s.type === 'ended' || s.type === 'error') {
      void playIndex(pointerRef.current)
    }
    // 'loading' / 'playing' → no-op
  }, [playIndex])

  const pause = useCallback(() => {
    const s = statusRef.current
    if (s.type === 'playing') {
      audioRef.current.pause()
      setStatus({ type: 'paused', paragraphId: s.paragraphId })
    }
  }, [])

  const stop = useCallback(() => {
    audioRef.current.stop()
    queueRef.current.clear()
    genRef.current++
    tokenRef.current++
    advancingRef.current = false
    pointerRef.current = 0
    setCurrentParagraphId(null)
    setStatus({ type: 'idle' })
    setBufferedAhead(0)
  }, [])

  const next = useCallback(() => {
    jumpTo(pointerRef.current + 1)
  }, [jumpTo])

  const prev = useCallback(() => {
    jumpTo(Math.max(0, pointerRef.current - 1))
  }, [jumpTo])

  const nextChapter = useCallback(() => {
    const cur = paragraphs[pointerRef.current]
    if (!cur) return
    const target = cur.chapterIndex + 1
    const idx = paragraphs.findIndex((p) => p.chapterIndex === target)
    if (idx >= 0) jumpTo(idx)
  }, [paragraphs, jumpTo])

  const prevChapter = useCallback(() => {
    const cur = paragraphs[pointerRef.current]
    if (!cur) return
    const target = cur.chapterIndex - 1
    const idx = paragraphs.findIndex((p) => p.chapterIndex === target)
    if (idx >= 0) jumpTo(idx)
  }, [paragraphs, jumpTo])

  const seekToParagraph = useCallback(
    (id: string) => {
      const index = paragraphs.findIndex((p) => p.id === id)
      if (index >= 0) jumpTo(index)
    },
    [paragraphs, jumpTo],
  )

  // Non-playing navigation: cancel in-flight playback, reposition the pointer
  // + highlight, and prime the buffer so the next `play()` starts here. Unlike
  // `seekToParagraph`/`jumpTo`, no audio is synthesized-for-playback and the
  // status returns to 'idle'.
  const navigateToParagraph = useCallback(
    (id: string) => {
      const index = paragraphs.findIndex((p) => p.id === id)
      const para = paragraphs[index]
      if (!para) return
      tokenRef.current++
      genRef.current++
      advancingRef.current = false
      audioRef.current.stop()
      pointerRef.current = index
      setCurrentParagraphId(para.id)
      prune(index)
      setStatus({ type: 'idle' })
      syncBufferedAhead()
      void primeAhead(index + 1)
    },
    [paragraphs, prune, syncBufferedAhead, primeAhead],
  )

  const seekBy = useCallback((deltaSeconds: number) => {
    audioRef.current.seekBy(deltaSeconds)
  }, [])

  const seekTo = useCallback((seconds: number) => {
    audioRef.current.seekTo(seconds)
  }, [])

  const getAudioPosition = useCallback(() => {
    return { currentTime: audioRef.current.currentTime, duration: audioRef.current.duration }
  }, [])

  const currentIndex = useMemo(
    () => (currentParagraphId ? paragraphs.findIndex((p) => p.id === currentParagraphId) : null),
    [currentParagraphId, paragraphs],
  )
  const currentParagraph =
    currentIndex !== null && currentIndex >= 0 ? (paragraphs[currentIndex] ?? null) : null

  return {
    status,
    currentParagraphId,
    currentParagraph,
    currentIndex,
    bufferedAhead,
    play,
    pause,
    stop,
    next,
    prev,
    nextChapter,
    prevChapter,
    seekToParagraph,
    navigateToParagraph,
    seekBy,
    seekTo,
    getAudioPosition,
  }
}
