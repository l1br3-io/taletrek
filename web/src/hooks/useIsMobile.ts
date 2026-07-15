import { useState } from 'react'

/**
 * Detect whether the user is on a touch-primary device (mobile/tablet).
 *
 * Uses `matchMedia('(pointer: coarse)')` — resolves on mount and stays fixed
 * for the session (users don't switch between touch/precision mid-session).
 * Defaults to `false` during SSR or when matchMedia is unavailable.
 *
 * (M9 / ADR-0006 — selects between `useStreamingPlayer` and `useParagraphPlayer`)
 */
export function useIsMobile(): boolean {
  const [mobile] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(pointer: coarse)').matches
  })
  return mobile
}
