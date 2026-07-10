/**
 * Media Session capability detection — wired only, no playback in M0.
 *
 * The real controls (lock-screen metadata, play/pause/skip handlers) land in
 * M2/M3. Here we just surface whether the browser supports the API so the rest
 * of the app can degrade gracefully.
 */

export function isMediaSessionSupported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
}

/** List the Media Session actions this browser claims to support. */
export function supportedMediaSessionActions(): MediaSessionAction[] {
  if (!isMediaSessionSupported()) return []
  // Sensible default set we plan to wire in M3.
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
      // Probing with null reports support without registering a real handler.
      navigator.mediaSession.setActionHandler(action, null)
      supported.push(action)
    } catch {
      // Unsupported action — skip.
    }
  }
  return supported
}
