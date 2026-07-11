import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TtsEngine } from '../lib/tts/types'
import type { Chapter, VoiceId } from '../types'

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
  | { type: 'playing'; paragraphId: string }
  | { type: 'paused'; paragraphId: string }
  | { type: 'ended' }
  | { type: 'error'; message: string }

/**
 * Injectable audio boundary so the hook (and its tests) never touch a real
 * `<audio>` element directly. The production impl wraps `new Audio()`.
 */
export interface AudioController {
  loadAndPlay(src: string): Promise<void>
  resume(): Promise<void>
  pause(): void
  stop(): void
  setPlaybackRate(rate: number): void
  /** Register an `ended` handler; returns an unsubscribe. */
  onEnded(handler: () => void): () => void
}

/** Create a real `AudioController` backed by an off-DOM `HTMLAudioElement`. */
export function createAudioController(): AudioController {
  const el = new Audio()
  el.preservesPitch = true
  return {
    async loadAndPlay(src: string) {
      el.src = src
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
  }
}

export interface UseParagraphPlayerArgs {
  chapters: Chapter[]
  voiceId: VoiceId
  playbackRate: number
  engine: TtsEngine
  /** Test override; defaults to a real `AudioController`. */
  audio?: AudioController
}

export interface UseParagraphPlayerResult {
  status: PlaybackStatus
  currentParagraphId: string | null
  play: () => void
  pause: () => void
  stop: () => void
  next: () => void
  prev: () => void
  seekToParagraph: (id: string) => void
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
 * Per-paragraph playback: synthesizes one paragraph at a time via `engine`,
 * plays it through a single `<audio>` element, and auto-advances on `ended`.
 * Exposes the currently-spoken paragraph id (for read-along highlight) and
 * tap-to-seek.
 *
 * The caller should mount this hook behind a `key={book.id}` so switching books
 * remounts and resets playback state (pointer, status, audio). Revokes every
 * Blob URL on advance and unmount — no leaks.
 */
export function useParagraphPlayer({
  chapters,
  voiceId,
  playbackRate,
  engine,
  audio,
}: UseParagraphPlayerArgs): UseParagraphPlayerResult {
  const paragraphs = useMemo(() => flattenParagraphs(chapters), [chapters])

  const [status, setStatus] = useState<PlaybackStatus>({ type: 'idle' })
  const [currentParagraphId, setCurrentParagraphId] = useState<string | null>(null)

  // Refs for values that must NOT trigger re-subscription when they change:
  // engine + voiceId affect only the *next* synthesis, not in-flight playback.
  const engineRef = useRef(engine)
  const voiceIdRef = useRef(voiceId)
  engineRef.current = engine
  voiceIdRef.current = voiceId

  const pointerRef = useRef(0)
  const urlRef = useRef<string | null>(null)
  const tokenRef = useRef(0) // bumped on every new synth request; stale results ignored
  const statusRef = useRef<PlaybackStatus>({ type: 'idle' })
  statusRef.current = status

  const audioRef = useRef<AudioController>(audio ?? createAudioController())

  const revokeUrl = useCallback(() => {
    if (urlRef.current !== null) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const synthAndPlay = useCallback(
    async (index: number) => {
      const para = paragraphs[index]
      if (!para) return
      const token = ++tokenRef.current
      pointerRef.current = index
      setCurrentParagraphId(para.id)
      setStatus({ type: 'loading' })
      try {
        const { audio: wav } = await engineRef.current.synthesize({
          text: para.text,
          voiceId: voiceIdRef.current,
        })
        // Ignore stale results (a newer seek/next superseded this request).
        if (token !== tokenRef.current) return
        const url = URL.createObjectURL(wav)
        revokeUrl()
        urlRef.current = url
        await audioRef.current.loadAndPlay(url)
        if (token !== tokenRef.current) return
        setStatus({ type: 'playing', paragraphId: para.id })
      } catch (error) {
        if (token !== tokenRef.current) return
        setStatus({
          type: 'error',
          message: error instanceof Error ? error.message : 'synthesis failed',
        })
      }
    },
    [paragraphs, revokeUrl],
  )

  // Auto-advance on `ended`. Guarded: a spurious `ended` can fire when we set a
  // new `src` mid-loading (the browser emits a stale event for the old media).
  // Only advance from a genuine 'playing' state.
  useEffect(() => {
    const unsubscribe = audioRef.current.onEnded(() => {
      if (statusRef.current.type !== 'playing') return
      const nextIndex = pointerRef.current + 1
      if (nextIndex < paragraphs.length) {
        void synthAndPlay(nextIndex)
      } else {
        revokeUrl()
        setStatus({ type: 'ended' })
      }
    })
    return unsubscribe
  }, [paragraphs, synthAndPlay, revokeUrl])

  // Apply playbackRate live.
  useEffect(() => {
    audioRef.current.setPlaybackRate(playbackRate)
  }, [playbackRate])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      audioRef.current.stop()
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
      tokenRef.current++
    }
  }, [])

  const play = useCallback(() => {
    const s = statusRef.current
    if (s.type === 'paused') {
      void audioRef.current.resume()
      setStatus({ type: 'playing', paragraphId: s.paragraphId })
      return
    }
    if (s.type === 'idle' || s.type === 'ended' || s.type === 'error') {
      void synthAndPlay(pointerRef.current)
    }
    // 'loading' / 'playing' → no-op
  }, [synthAndPlay])

  const pause = useCallback(() => {
    const s = statusRef.current
    if (s.type === 'playing') {
      audioRef.current.pause()
      setStatus({ type: 'paused', paragraphId: s.paragraphId })
    }
  }, [])

  const stop = useCallback(() => {
    audioRef.current.stop()
    revokeUrl()
    pointerRef.current = 0
    tokenRef.current++
    setCurrentParagraphId(null)
    setStatus({ type: 'idle' })
  }, [revokeUrl])

  const next = useCallback(() => {
    void synthAndPlay(pointerRef.current + 1)
  }, [synthAndPlay])

  const prev = useCallback(() => {
    void synthAndPlay(Math.max(0, pointerRef.current - 1))
  }, [synthAndPlay])

  const seekToParagraph = useCallback(
    (id: string) => {
      const index = paragraphs.findIndex((p) => p.id === id)
      if (index >= 0) void synthAndPlay(index)
    },
    [paragraphs, synthAndPlay],
  )

  return {
    status,
    currentParagraphId,
    play,
    pause,
    stop,
    next,
    prev,
    seekToParagraph,
  }
}
