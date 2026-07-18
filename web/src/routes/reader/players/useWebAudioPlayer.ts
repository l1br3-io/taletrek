import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AudioBufferLike,
  type AudioContextLike,
  ParagraphScheduler,
  type SchedulerAudioState,
  type SchedulerParagraph,
} from '../../../lib/audio/web-audio/scheduler'
import type { TtsEngine } from '../../../lib/tts/types'
import type { BookId, Chapter, VoiceId } from '../../../types'
import { flattenParagraphs, type PlaybackStatus, type UseParagraphPlayerResult } from './types'

export interface UseWebAudioPlayerArgs {
  chapters: Chapter[]
  voiceId: VoiceId
  playbackRate: number
  engine: TtsEngine
  initialIndex?: number
  bookId?: BookId
}

/**
 * Mobile playback engine — native Web Audio (ADR-0010 / M11).
 *
 * Decodes paragraph WAVs from M8's content-addressed cache (cache misses
 * synthesize on demand via the shared TTS engine) and schedules them gaplessly
 * on an `AudioContext` via {@link ParagraphScheduler}. No FFmpeg, no encode,
 * no 30 MB core download.
 *
 * Audio is routed through a `MediaStreamAudioDestinationNode` → hidden
 * `<video>` element (2px, near-zero opacity — same trick as the FFmpeg
 * whole-book path) so iOS detects active media and surfaces a Now Playing
 * card with controls on the lock screen.
 *
 * Returns the shared {@link UseParagraphPlayerResult} so every UI surface is
 * engine-agnostic.
 */
export function useWebAudioPlayer({
  chapters,
  voiceId,
  playbackRate,
  engine,
  initialIndex,
  bookId,
}: UseWebAudioPlayerArgs): UseParagraphPlayerResult {
  const paragraphs = useMemo(() => flattenParagraphs(chapters), [chapters])

  const [status, setStatus] = useState<PlaybackStatus>({ type: 'idle' })
  const [currentParagraphId, setCurrentParagraphId] = useState<string | null>(() => {
    if (initialIndex === undefined || initialIndex <= 0) return null
    return paragraphs[initialIndex]?.id ?? null
  })
  const [bufferedAhead, setBufferedAhead] = useState(0)

  const engineRef = useRef(engine)
  const voiceIdRef = useRef(voiceId)
  const bookIdRef = useRef(bookId)
  engineRef.current = engine
  voiceIdRef.current = voiceId
  bookIdRef.current = bookId

  const pointerRef = useRef(initialIndex ?? 0)
  const statusRef = useRef<PlaybackStatus>({ type: 'idle' })
  statusRef.current = status

  const pausedBySystemRef = useRef(false)

  const ctxRef = useRef<AudioContext | null>(null)
  const schedulerRef = useRef<ParagraphScheduler | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const paragraphsVersionRef = useRef(0)

  /** Lazily create the AudioContext + scheduler on first play (user gesture). */
  const ensureEngine = useCallback((): ParagraphScheduler => {
    if (schedulerRef.current) return schedulerRef.current
    const ctor =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!ctor) {
      throw new Error('Web Audio playback requires AudioContext support')
    }
    const ctx = new ctor() as AudioContext
    ctxRef.current = ctx

    // Route the entire AudioContext graph through a MediaStream → <video>
    // element. The <video> carries the real audio and must be visible
    // (not display:none) so iOS surfaces a Now Playing card on lock.
    // Same visibility trick as the FFmpeg whole-book path.
    const streamNode = ctx.createMediaStreamDestination()
    streamNodeRef.current = streamNode
    const mixGain = ctx.createGain()
    mixGain.connect(streamNode)

    const video = document.createElement('video')
    video.setAttribute('playsinline', '')
    video.srcObject = streamNode.stream
    video.style.cssText =
      'position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0.01;z-index:-1;pointer-events:none;'
    document.body.appendChild(video)
    videoRef.current = video

    const scheduler = new ParagraphScheduler(
      ctx as unknown as AudioContextLike,
      {
        onParagraphChange: (index) => {
          const para = paragraphs[index]
          if (!para) return
          pointerRef.current = index
          setCurrentParagraphId(para.id)
          setStatus({ type: 'playing', paragraphId: para.id })
          setBufferedAhead(schedulerRef.current?.getBufferedAhead() ?? 0)
        },
        onEnded: () => setStatus({ type: 'ended' }),
        onStateChange: (state: SchedulerAudioState) => {
          if (state === 'suspended' || state === 'interrupted') {
            const s = statusRef.current
            if (s.type === 'playing') {
              pausedBySystemRef.current = true
              setStatus({ type: 'paused', paragraphId: s.paragraphId })
            }
          }
          if (state === 'running' && pausedBySystemRef.current) {
            pausedBySystemRef.current = false
            const s = statusRef.current
            if (s.type === 'paused') {
              void videoRef.current?.play().catch(() => {})
              setStatus({ type: 'playing', paragraphId: s.paragraphId })
            }
          }
        },
      },
      { lookahead: 3, destination: mixGain },
    )
    schedulerRef.current = scheduler
    return scheduler
  }, [paragraphs])

  /** Build SchedulerParagraph[] from the current chapters + voice. */
  const buildParagraphs = useCallback((): SchedulerParagraph[] => {
    paragraphsVersionRef.current++
    return paragraphs.map((para) => ({
      id: para.id,
      duration: 0,
      getBuffer: async (): Promise<AudioBufferLike> => {
        const result = await engineRef.current.synthesize({
          text: para.text,
          voiceId: voiceIdRef.current,
          ...(bookIdRef.current !== undefined ? { bookId: bookIdRef.current } : {}),
        })
        if (!result.audio) throw new Error('engine returned no audio for Web Audio playback')
        const ab = await result.audio.arrayBuffer()
        const activeCtx = ctxRef.current
        if (!activeCtx) throw new Error('AudioContext closed before decode')
        return activeCtx.decodeAudioData(ab)
      },
    }))
  }, [paragraphs])

  // Push paragraphs to the scheduler whenever chapters/voice change post-create.
  const prevSigRef = useRef<string>(`${paragraphs.length}:${voiceId}`)
  useEffect(() => {
    const sig = `${paragraphs.length}:${voiceId}`
    if (prevSigRef.current === sig) return
    prevSigRef.current = sig
    const scheduler = schedulerRef.current
    if (!scheduler) return
    pointerRef.current = 0
    setCurrentParagraphId(null)
    setStatus({ type: 'idle' })
    scheduler.setParagraphs(buildParagraphs())
  }, [paragraphs, voiceId, buildParagraphs])

  // Reflect playback-rate changes onto the scheduler (re-anchors the schedule).
  const prevRateRef = useRef(playbackRate)
  useEffect(() => {
    if (prevRateRef.current === playbackRate) return
    prevRateRef.current = playbackRate
    schedulerRef.current?.setPlaybackRate(playbackRate)
  }, [playbackRate])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      schedulerRef.current?.dispose()
      schedulerRef.current = null
      void ctxRef.current?.close().catch(() => {})
      ctxRef.current = null
      if (videoRef.current) {
        videoRef.current.pause()
        videoRef.current.srcObject = null
        videoRef.current.remove()
        videoRef.current = null
      }
      streamNodeRef.current = null
    }
  }, [])

  const play = useCallback(async () => {
    const s = statusRef.current
    if (s.type === 'paused') {
      void videoRef.current?.play().catch(() => {})
      await schedulerRef.current?.resume()
      if (ctxRef.current?.state === 'running') {
        setStatus({ type: 'playing', paragraphId: s.paragraphId })
      }
      return
    }
    if (s.type === 'idle' || s.type === 'ended' || s.type === 'error') {
      try {
        const scheduler = ensureEngine()
        scheduler.setParagraphs(buildParagraphs())
        scheduler.setPlaybackRate(playbackRate)
        setStatus({ type: 'loading' })
        await scheduler.play(pointerRef.current)
        const idx = pointerRef.current
        const para = paragraphs[idx]
        if (para) {
          setCurrentParagraphId(para.id)
          setStatus({ type: 'playing', paragraphId: para.id })
        }
        setBufferedAhead(scheduler.getBufferedAhead())
        void videoRef.current?.play().catch(() => {})
      } catch (error) {
        setStatus({
          type: 'error',
          message: error instanceof Error ? error.message : 'playback failed',
        })
      }
    }
  }, [ensureEngine, buildParagraphs, playbackRate, paragraphs])

  const pause = useCallback(async () => {
    const s = statusRef.current
    if (s.type === 'playing') {
      pausedBySystemRef.current = false
      await schedulerRef.current?.pause()
      videoRef.current?.pause()
      setStatus({ type: 'paused', paragraphId: s.paragraphId })
    }
  }, [])

  const stop = useCallback(() => {
    schedulerRef.current?.stop()
    videoRef.current?.pause()
    pausedBySystemRef.current = false
    pointerRef.current = 0
    setCurrentParagraphId(null)
    setBufferedAhead(0)
    setStatus({ type: 'idle' })
  }, [])

  const jumpTo = useCallback(
    async (index: number) => {
      const para = paragraphs[index]
      if (!para) return
      pointerRef.current = index
      const scheduler = schedulerRef.current
      if (!scheduler) {
        setCurrentParagraphId(para.id)
        return
      }
      setStatus({ type: 'loading' })
      try {
        await scheduler.seekToParagraph(index)
        setCurrentParagraphId(para.id)
        setStatus({ type: 'playing', paragraphId: para.id })
        setBufferedAhead(scheduler.getBufferedAhead())
      } catch {
        setStatus({ type: 'error', message: 'seek failed' })
      }
    },
    [paragraphs],
  )

  const next = useCallback(() => void jumpTo(pointerRef.current + 1), [jumpTo])
  const prev = useCallback(() => void jumpTo(Math.max(0, pointerRef.current - 1)), [jumpTo])

  const nextChapter = useCallback(() => {
    const cur = paragraphs[pointerRef.current]
    if (!cur) return
    const target = cur.chapterIndex + 1
    const idx = paragraphs.findIndex((p) => p.chapterIndex === target)
    if (idx >= 0) void jumpTo(idx)
  }, [paragraphs, jumpTo])

  const prevChapter = useCallback(() => {
    const cur = paragraphs[pointerRef.current]
    if (!cur) return
    const target = cur.chapterIndex - 1
    const idx = paragraphs.findIndex((p) => p.chapterIndex === target)
    if (idx >= 0) void jumpTo(idx)
  }, [paragraphs, jumpTo])

  const seekToParagraph = useCallback(
    (id: string) => {
      const idx = paragraphs.findIndex((p) => p.id === id)
      if (idx >= 0) void jumpTo(idx)
    },
    [paragraphs, jumpTo],
  )

  const navigateToParagraph = useCallback(
    (id: string) => {
      const idx = paragraphs.findIndex((p) => p.id === id)
      const para = paragraphs[idx]
      if (!para) return
      pointerRef.current = idx
      setCurrentParagraphId(para.id)
      schedulerRef.current?.seekToParagraph(idx).catch(() => {})
      setStatus({ type: 'idle' })
    },
    [paragraphs],
  )

  const seekBy = useCallback((_deltaSeconds: number) => {}, [])
  const seekTo = useCallback((_seconds: number) => {}, [])

  const getAudioPosition = useCallback(() => {
    return schedulerRef.current?.getAudioPosition() ?? { currentTime: 0, duration: 0 }
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
