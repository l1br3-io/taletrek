import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type BookAudio, getBookAudio } from '../../../lib/book-audio'
import type { TtsEngine } from '../../../lib/tts/types'
import type { BookId, Chapter, VoiceId } from '../../../types'
import { flattenParagraphs, type PlaybackStatus, type UseParagraphPlayerResult } from './types'

export interface UsePreloadedPlayerArgs {
  chapters: Chapter[]
  voiceId: VoiceId
  playbackRate: number
  engine?: TtsEngine
  initialIndex?: number
  bookId?: BookId
}

export function usePreloadedPlayer({
  chapters,
  playbackRate,
  initialIndex,
  bookId,
}: UsePreloadedPlayerArgs): UseParagraphPlayerResult {
  const paragraphs = useMemo(() => flattenParagraphs(chapters), [chapters])

  const [status, setStatus] = useState<PlaybackStatus>({ type: 'idle' })
  const [currentParagraphId, setCurrentParagraphId] = useState<string | null>(() => {
    if (initialIndex === undefined || initialIndex <= 0) return null
    return paragraphs[initialIndex]?.id ?? null
  })
  const [bufferedAhead, setBufferedAhead] = useState(0)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const bookAudioRef = useRef<BookAudio | null>(null)
  const offsetsRef = useRef<number[]>([])
  const durationsRef = useRef<number[]>([])
  const pointerRef = useRef(initialIndex ?? 0)
  const statusRef = useRef<PlaybackStatus>({ type: 'idle' })
  const playTokenRef = useRef(0)
  statusRef.current = status

  const createVideo = useCallback((): HTMLVideoElement => {
    const v = document.createElement('video')
    v.style.cssText =
      'position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0.01;z-index:-1;pointer-events:none;'
    v.disableRemotePlayback = true
    v.setAttribute('playsinline', '')
    v.setAttribute('webkit-playsinline', '')
    document.body.appendChild(v)
    return v
  }, [])

  const startPlayback = useCallback(
    async (index: number) => {
      const para = paragraphs[index]
      if (!para || !bookId) return

      const token = ++playTokenRef.current
      pointerRef.current = index

      if (!videoRef.current) {
        videoRef.current = createVideo()
      }
      const video = videoRef.current

      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }

      let ba: BookAudio | null | undefined = bookAudioRef.current
      if (!ba) {
        const fetchResult = await getBookAudio(bookId)
        if (!fetchResult) {
          if (token !== playTokenRef.current) return
          setStatus({ type: 'error', message: 'Audio not ready — please re-upload the book' })
          return
        }
        ba = fetchResult
        bookAudioRef.current = ba
        offsetsRef.current = ba.paragraphOffsets
        durationsRef.current = ba.durations
      }

      setBufferedAhead(offsetsRef.current.length - index - 1)

      const blobUrl = URL.createObjectURL(ba.blob)
      blobUrlRef.current = blobUrl
      video.src = blobUrl
      video.playbackRate = playbackRate

      setStatus({ type: 'loading' })

      await new Promise<void>((resolve) => {
        const onCanPlay = () => {
          video.removeEventListener('canplay', onCanPlay)
          resolve()
        }
        video.addEventListener('canplay', onCanPlay)
        video.load()
      })

      if (token !== playTokenRef.current) return

      video.currentTime = offsetsRef.current[index] ?? 0

      try {
        await video.play()
        if (token !== playTokenRef.current) return
        setStatus({ type: 'playing', paragraphId: para.id })
        setCurrentParagraphId(para.id)
      } catch {
        if (token !== playTokenRef.current) return
        setStatus({ type: 'paused', paragraphId: para.id })
      }
    },
    [bookId, createVideo, playbackRate, paragraphs],
  )

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTimeUpdate = () => {
      const offsets = offsetsRef.current
      if (offsets.length === 0) return
      let lo = 0
      let hi = offsets.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if ((offsets[mid] ?? 0) <= video.currentTime) lo = mid
        else hi = mid - 1
      }
      pointerRef.current = lo
      const para = paragraphs[lo]
      if (para && para.id !== currentParagraphId) {
        setCurrentParagraphId(para.id)
      }

      if (
        statusRef.current.type === 'playing' &&
        video.currentTime >= video.duration - 0.1 &&
        lo >= offsets.length - 1
      ) {
        setStatus({ type: 'ended' })
      }
    }
    video.addEventListener('timeupdate', onTimeUpdate)
    return () => video.removeEventListener('timeupdate', onTimeUpdate)
  }, [paragraphs, currentParagraphId])

  useEffect(() => {
    const v = videoRef.current
    if (v && v.playbackRate !== playbackRate) {
      v.playbackRate = playbackRate
    }
  }, [playbackRate])

  useEffect(() => {
    return () => {
      playTokenRef.current++
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
      if (videoRef.current) {
        videoRef.current.remove()
        videoRef.current = null
      }
    }
  }, [])

  const currentIndex = useMemo(
    () => (currentParagraphId ? paragraphs.findIndex((p) => p.id === currentParagraphId) : null),
    [currentParagraphId, paragraphs],
  )
  const currentParagraph =
    currentIndex !== null && currentIndex >= 0 ? (paragraphs[currentIndex] ?? null) : null

  const play = useCallback(async () => {
    const s = statusRef.current
    if (s.type === 'paused') {
      try {
        await videoRef.current?.play()
        setStatus({ type: 'playing', paragraphId: s.paragraphId })
      } catch {
        setStatus({ type: 'error', message: 'Tap Play to start playback' })
      }
      return
    }
    if (s.type === 'idle' || s.type === 'ended' || s.type === 'error') {
      void startPlayback(pointerRef.current)
    }
  }, [startPlayback])

  const pause = useCallback(() => {
    const s = statusRef.current
    if (s.type === 'playing') {
      videoRef.current?.pause()
      setStatus({ type: 'paused', paragraphId: s.paragraphId })
    }
  }, [])

  const stop = useCallback(() => {
    playTokenRef.current++
    videoRef.current?.pause()
    if (videoRef.current) videoRef.current.removeAttribute('src')
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    blobUrlRef.current = null
    bookAudioRef.current = null
    pointerRef.current = 0
    setCurrentParagraphId(null)
    setStatus({ type: 'idle' })
    setBufferedAhead(0)
  }, [])

  const seekToParagraph = useCallback(
    (id: string) => {
      const idx = paragraphs.findIndex((p) => p.id === id)
      if (idx < 0) return
      const video = videoRef.current
      if (!video) return
      const offset = offsetsRef.current[idx] ?? 0
      pointerRef.current = idx
      video.currentTime = offset
      setCurrentParagraphId(id)
    },
    [paragraphs],
  )

  const navigateToParagraph = useCallback(
    (id: string) => {
      seekToParagraph(id)
      videoRef.current?.pause()
      setStatus({ type: 'idle' })
    },
    [seekToParagraph],
  )

  const next = useCallback(() => {
    seekToParagraph(paragraphs[pointerRef.current + 1]?.id ?? '')
  }, [paragraphs, seekToParagraph])

  const prev = useCallback(() => {
    seekToParagraph(paragraphs[Math.max(0, pointerRef.current - 1)]?.id ?? '')
  }, [paragraphs, seekToParagraph])

  const nextChapter = useCallback(() => {
    const cur = paragraphs[pointerRef.current]
    if (!cur) return
    const idx = paragraphs.findIndex((p) => p.chapterIndex === cur.chapterIndex + 1)
    if (idx >= 0) seekToParagraph(paragraphs[idx]?.id ?? '')
  }, [paragraphs, seekToParagraph])

  const prevChapter = useCallback(() => {
    const cur = paragraphs[pointerRef.current]
    if (!cur) return
    const idx = paragraphs.findIndex((p) => p.chapterIndex === cur.chapterIndex - 1)
    if (idx >= 0) seekToParagraph(paragraphs[idx]?.id ?? '')
  }, [paragraphs, seekToParagraph])

  const seekBy = useCallback((deltaSeconds: number) => {
    const video = videoRef.current
    if (video) video.currentTime = Math.max(0, video.currentTime + deltaSeconds)
  }, [])

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video) return
    const offset = offsetsRef.current[pointerRef.current] ?? 0
    video.currentTime = offset + seconds
  }, [])

  const getAudioPosition = useCallback(() => {
    const video = videoRef.current
    if (!video) return { currentTime: 0, duration: 0 }
    const offset = offsetsRef.current[pointerRef.current] ?? 0
    const dur = durationsRef.current[pointerRef.current] ?? video.duration
    return {
      currentTime: Math.max(0, video.currentTime - offset),
      duration: dur || video.duration,
    }
  }, [])

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
