/**
 * Module-load capture for the PWA `beforeinstallprompt` event.
 *
 * Chrome on Android fires `beforeinstallprompt` early — typically on first
 * page load, often before the user has navigated to `/settings` where the
 * install affordance lives. A listener attached in a React `useEffect` (the
 * pre-2026-07 pattern) misses the event entirely; the install button never
 * appeared on Android. iOS Safari is unaffected because it never fires the
 * event and the affordance shows manual "Add to Home Screen" instructions
 * unconditionally.
 *
 * This module attaches its listeners at **module load** (before React mounts
 * via the side-effect import in `main.tsx`), stashes the captured event, and
 * re-emits to subscribers. `InstallPrompt` consumes it via `useSyncExternalStore`
 * — late mounters still see an event that fired before they subscribed.
 *
 * Singleton + external-store shape mirrors `uploadManager` /
 * `bookTransformManager`. No IDB persistence; dismiss-stickiness lives in
 * `localStorage` and is owned by the `InstallPrompt` component (rendering
 * concern, not capture concern).
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface InstallState {
  /** Captured `BeforeInstallPromptEvent`, or null until Chrome fires one. */
  captured: BeforeInstallPromptEvent | null
  /** True once `appinstalled` fires or `display-mode: standalone` matches. */
  installed: boolean
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  )
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

let state: InstallState = {
  captured: null,
  // Read at module load — the listener below will flip `installed` on the
  // `appinstalled` event for in-session installs. Cheap; only runs once.
  installed: isStandalone(),
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function setState(next: InstallState): void {
  state = next
  emit()
}

if (typeof window !== 'undefined') {
  // `preventDefault` keeps Chrome's own install-prompt from firing so we can
  // surface the affordance where the user actually expects it (Settings).
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    setState({ captured: e as BeforeInstallPromptEvent, installed: state.installed })
  })
  window.addEventListener('appinstalled', () => {
    setState({ captured: null, installed: true })
  })
}

/** Current snapshot — stable reference unless state actually changes. */
export function getInstallState(): InstallState {
  return state
}

/** Subscribe to install-state changes (external-store compatible). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Trigger the captured prompt. Resolves after the browser's install dialog
 * closes (accepted or dismissed). No-op when no event is captured. Clears the
 * captured event either way so the affordance disappears after the user has
 * decided.
 */
export async function triggerInstallPrompt(): Promise<void> {
  const captured = state.captured
  if (!captured) return
  try {
    await captured.prompt()
    await captured.userChoice
  } finally {
    setState({ captured: null, installed: state.installed })
  }
}

/** Test-only: clear captured state so cases don't bleed into each other. */
export function _resetForTests(): void {
  state = { captured: null, installed: isStandalone() }
}
