import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AudioController, createAudioController } from '../../../lib/audio-controller'
import type { TtsEngine } from '../../../lib/tts/types'
import type { BookId, Chapter, VoiceId } from '../../../types'
import {
  DEFAULT_LOOKAHEAD,
  flattenParagraphs,
  type PlaybackStatus,
  type UseParagraphPlayerResult,
} from './types'

export interface UseDesktopPlayerArgs {
  chapters: Chapter[]
  voiceId: VoiceId
  playbackRate: number
  engine: TtsEngine
  lookahead?: number
  audio?: AudioController
  initialIndex?: number
  bookId?: BookId
  backgroundActive?: boolean
  backgroundBufferedIds?: Set<string>
  cachedParagraphIds?: Set<string>
  onParagraphSynthesized?: (paragraphId: string) => void
}

type PrerenderedChunk = {
  blob: Blob
  index: number
}

export function useDesktopPlayer({
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
}: UseDesktopPlayerArgs): UseParagraphPlayerResult {
  const paragraphs = useMemo(() => flattenParagraphs(chapters), [chapters])
  const la = Math.max(0, Math.trunc(lookahead))

  const [status, setStatus] = useState<PlaybackStatus>({ type: 'idle' })
  const [currentParagraphId, setCurrentParagraphId] = useState<string | null>(() => {
    if (initialIndex === undefined || initialIndex <= 0) return null
    return paragraphs[initialIndex]?.id ?? null
  })
  const [bufferedAhead, setBufferedAhead] = useState(0)

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
  const tokenRef = useRef(0)
  const genRef = useRef(0)
  const statusRef = useRef<PlaybackStatus>({ type: 'idle' })
  statusRef.current = status

  const audioRef = useRef<AudioController>(audio ?? createAudioController())
  const queueRef = useRef<Map<string, PrerenderedChunk>>(new Map())
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
          if (gen !== genRef.current) return
        }
      }
    },
    [paragraphs, la, syncBufferedAhead],
  )

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

  const jumpTo = useCallback(
    (index: number) => {
      genRef.current++
      void playIndex(index)
    },
    [playIndex],
  )

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

  useEffect(() => {
    audioRef.current.setPlaybackRate(playbackRate)
  }, [playbackRate])

  const prevVoiceRef = useRef(voiceId)
  useEffect(() => {
    if (prevVoiceRef.current === voiceId) return
    prevVoiceRef.current = voiceId
    genRef.current++
    queueRef.current.clear()
    syncBufferedAhead()
  }, [voiceId, syncBufferedAhead])

  const prevParagraphsRef = useRef(paragraphs)
  useEffect(() => {
    if (prevParagraphsRef.current === paragraphs) return
    prevParagraphsRef.current = paragraphs
    genRef.current++
    queueRef.current.clear()
    syncBufferedAhead()
  }, [paragraphs, syncBufferedAhead])

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
