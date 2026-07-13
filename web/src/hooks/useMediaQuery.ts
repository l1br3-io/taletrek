import { useEffect, useState } from 'react'

/**
 * Subscribe to a CSS media query. Returns `true` while the query matches.
 * SSR-safe and jsdom-safe (returns `false` when `matchMedia` is unavailable).
 *
 * @example const isDesktop = useMediaQuery('(min-width: 640px)')
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
