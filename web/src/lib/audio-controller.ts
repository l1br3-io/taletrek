/**
 * Injectable audio boundary so the paragraph player hook (and its tests) never
 * touch a real `<audio>` element directly. The production impl wraps `new Audio()`.
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
