/**
 * Screen Wake Lock helper for long-running upload/synth jobs.
 *
 * Acquires a `navigator.wakeLock.request('screen')` sentinel and keeps it
 * alive across the auto-release events browsers fire (tab hide, OEM
 * power-save, etc.). Re-acquires on `visibilitychange` and on the sentinel's
 * own `release` event.
 *
 * Contract: `acquireUploadWakeLock` **never throws**. Any failure (missing
 * API, rejected promise, transient error) resolves to a no-op handle whose
 * `release()` is also a no-op. Callers must not let wake-lock failure abort
 * real work — the upload runs regardless.
 *
 * Browser support: Chrome/Edge/Android, Safari 16.4+. Older Safari silently
 * falls back to the no-op handle (the existing "stall when locked" behaviour).
 */

export interface WakeLockHandle {
  release(): Promise<void>
}

const NOOP_HANDLE: WakeLockHandle = {
  async release() {},
}

function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/**
 * Public export of {@link isWakeLockSupported} for UI affordances — the
 * global synth banner shows a stronger "your browser can't keep the screen
 * awake" warning when this returns false (iOS Safari < 16.4, older Firefox).
 */
export function canKeepScreenAwake(): boolean {
  return isWakeLockSupported()
}

class ActiveHandle implements WakeLockHandle {
  private sentinel: WakeLockSentinel | null = null
  private deliberatelyReleased = false
  private reacquiring = false
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && !this.deliberatelyReleased) {
      void this.reacquire()
    }
  }

  constructor(sentinel: WakeLockSentinel) {
    this.sentinel = sentinel
    sentinel.onrelease = () => {
      if (this.deliberatelyReleased) return
      this.sentinel = null
      void this.reacquire()
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  private async reacquire(): Promise<void> {
    if (this.sentinel || this.deliberatelyReleased || this.reacquiring) return
    if (!isWakeLockSupported() || document.visibilityState !== 'visible') return
    this.reacquiring = true
    try {
      const next = await navigator.wakeLock.request('screen')
      if (this.deliberatelyReleased) {
        // Released while we were awaiting — drop the new sentinel.
        try {
          await next.release()
        } catch {
          // best-effort
        }
        return
      }
      this.sentinel = next
      next.onrelease = () => {
        if (this.deliberatelyReleased) return
        this.sentinel = null
        void this.reacquire()
      }
    } catch (error) {
      console.info('[taletrek] wake-lock re-acquire failed:', error)
    } finally {
      this.reacquiring = false
    }
  }

  async release(): Promise<void> {
    this.deliberatelyReleased = true
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    const s = this.sentinel
    this.sentinel = null
    if (!s) return
    try {
      await s.release()
    } catch (error) {
      console.info('[taletrek] wake-lock release failed:', error)
    }
  }
}

/**
 * Acquire a screen wake lock. Always resolves — failures degrade to a no-op
 * handle so the caller's real work is never blocked by wake-lock trouble.
 */
export async function acquireUploadWakeLock(): Promise<WakeLockHandle> {
  if (!isWakeLockSupported()) return NOOP_HANDLE
  if (document.visibilityState !== 'visible') {
    // Spec: request() rejects if document is hidden. Return a no-op instead
    // of attempting; visibilitychange won't fire on this handle (we'd need a
    // long-lived listener), so the caller simply runs without a lock. The
    // next job started from a visible document will acquire normally.
    return NOOP_HANDLE
  }
  try {
    const sentinel = await navigator.wakeLock.request('screen')
    return new ActiveHandle(sentinel)
  } catch (error) {
    console.info('[taletrek] wake-lock acquire failed:', error)
    return NOOP_HANDLE
  }
}
