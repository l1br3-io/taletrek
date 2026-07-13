/** Scroll an element to the center of the viewport. No-op when element is absent. */
export function scrollIntoViewCenter(
  el: Element | null,
  behavior: ScrollBehavior = 'smooth',
): void {
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior })
}

/** True when any part of `el` intersects the viewport. */
export function isInViewport(el: Element | null): boolean {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  const vh = window.innerHeight ?? document.documentElement.clientHeight
  return rect.top < vh && rect.bottom > 0
}
