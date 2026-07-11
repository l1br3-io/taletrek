/**
 * Media Session integration — lock-screen / OS media controls.
 *
 * M0 shipped capability detection only; M3 wires the real controls: metadata
 * (title/artist/album/artwork), action handlers (play/pause/seek/skip), and
 * playback/position state. Every call is guarded by `isMediaSessionSupported()`
 * so the app degrades gracefully where the API is unavailable.
 */

export function isMediaSessionSupported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
}

/** List the Media Session actions this browser claims to support. */
export function supportedMediaSessionActions(): MediaSessionAction[] {
  if (!isMediaSessionSupported()) return []
  const candidates = [
    'play',
    'pause',
    'seekbackward',
    'seekforward',
    'seekto',
    'nexttrack',
    'previoustrack',
  ] as const
  const supported: MediaSessionAction[] = []
  for (const action of candidates) {
    try {
      navigator.mediaSession.setActionHandler(action, null)
      supported.push(action)
    } catch {
      // Unsupported action — skip.
    }
  }
  return supported
}

/** Metadata shown on the lock screen / OS media UI. */
export interface MediaMetadataInput {
  /** Typically the book title. */
  title: string
  /** Author, or 'TaleTrek'. */
  artist: string
  /** Current chapter title. */
  album: string
  /** Artwork URL (app icon; book covers are M5). */
  artworkUrl: string
}

/** Set the lock-screen metadata. No-op when Media Session is unavailable. */
export function setMediaMetadata(input: MediaMetadataInput): void {
  if (!isMediaSessionSupported()) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: input.title,
      artist: input.artist,
      album: input.album,
      artwork: [{ src: input.artworkUrl, sizes: '512x512', type: 'image/png' }],
    })
  } catch {
    // MediaMetadata unavailable — degrade gracefully.
  }
}

/** Callbacks bound by the playback container to Media Session actions. */
export interface MediaSessionActionHandlers {
  play: () => void
  pause: () => void
  seekbackward: () => void
  seekforward: () => void
  /** `null` when the OS didn't supply a target time (rare). */
  seekto: (seekTime: number | null) => void
  /** Skip to the next chapter. */
  nexttrack: () => void
  /** Skip to the previous chapter. */
  previoustrack: () => void
}

const SESSION_ACTIONS: MediaSessionAction[] = [
  'play',
  'pause',
  'seekbackward',
  'seekforward',
  'seekto',
  'nexttrack',
  'previoustrack',
]

/**
 * Register all Media Session action handlers. Returns a cleanup that
 * de-registers them. Unsupported actions are skipped (no throw). No-op (returns
 * an empty cleanup) when Media Session is unavailable.
 */
export function setMediaSessionHandlers(handlers: MediaSessionActionHandlers): () => void {
  if (!isMediaSessionSupported()) return () => {}
  const ms = navigator.mediaSession
  const wrapped: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => handlers.play(),
    pause: () => handlers.pause(),
    seekbackward: () => handlers.seekbackward(),
    seekforward: () => handlers.seekforward(),
    seekto: (details) => handlers.seekto(details.seekTime ?? null),
    nexttrack: () => handlers.nexttrack(),
    previoustrack: () => handlers.previoustrack(),
  }
  for (const action of SESSION_ACTIONS) {
    const handler = wrapped[action] ?? null
    try {
      ms.setActionHandler(action, handler)
    } catch {
      // Unsupported action — skip.
    }
  }
  return () => {
    for (const action of SESSION_ACTIONS) {
      try {
        ms.setActionHandler(action, null)
      } catch {
        // Unsupported action — ignore.
      }
    }
  }
}

export type MediaPlaybackState = 'playing' | 'paused' | 'none'

/** Update the OS-reported playback state (drives play/pause button state). */
export function setMediaPlaybackState(state: MediaPlaybackState): void {
  if (!isMediaSessionSupported()) return
  navigator.mediaSession.playbackState = state
}

/**
 * Update the lock-screen seekbar. `setPositionState` rejects invalid values
 * (NaN, negative, position > duration) — this wrapper validates first and
 * no-ops on invalid input or when the API is unavailable.
 */
export function setMediaPositionState(
  duration: number,
  position: number,
  playbackRate: number,
): void {
  if (!isMediaSessionSupported()) return
  const ms = navigator.mediaSession
  if (typeof ms.setPositionState !== 'function') return
  if (!Number.isFinite(duration) || duration <= 0) return
  if (!Number.isFinite(position) || position < 0 || position > duration) return
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) return
  try {
    ms.setPositionState({ duration, position, playbackRate })
  } catch {
    // Invalid state for this browser — ignore.
  }
}

/** Reset Media Session to an idle state (clear metadata, handlers, state). */
export function clearMediaSession(): void {
  if (!isMediaSessionSupported()) return
  const ms = navigator.mediaSession
  ms.metadata = null
  for (const action of SESSION_ACTIONS) {
    try {
      ms.setActionHandler(action, null)
    } catch {
      // Unsupported action — ignore.
    }
  }
  ms.playbackState = 'none'
}
