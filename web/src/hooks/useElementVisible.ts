import type { RefObject } from 'react'
import { useEffect, useState } from 'react'
import { isInViewport } from '../lib/scroll'

/**
 * Track whether the element referenced by `ref` is in the viewport. Re-observes
 * whenever `dep` changes (e.g. the active paragraph id), since the same ref
 * object is re-attached to a new DOM node. Falls back to "visible" when no
 * element or no IntersectionObserver (jsdom).
 */
export function useElementVisible(ref: RefObject<Element | null>, dep: unknown): boolean {
  const [visible, setVisible] = useState(true)

  // `dep` drives re-observation when the target node changes; `ref.current` is
  // intentionally read fresh each run rather than listed as a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dep is the re-observation trigger; ref is stable
  useEffect(() => {
    const el = ref.current
    if (!el) {
      setVisible(true)
      return
    }
    setVisible(isInViewport(el))
    if (typeof IntersectionObserver === 'undefined') return
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setVisible(entry.isIntersecting)
      },
      {
        threshold: 0.1,
      },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [dep])

  return visible
}
