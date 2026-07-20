import { useSyncExternalStore } from 'react'
import { type BookTransformState, bookTransformManager } from './manager'

/**
 * Subscribe to the global book-transform-manager state from React. Backed by
 * `useSyncExternalStore` so only components that actually read the state
 * re-render on progress ticks — the rest of the tree is untouched.
 *
 * `getState`/`subscribe` are bound arrow properties on the singleton, so the
 * references are stable across renders (required by `useSyncExternalStore`).
 *
 * The manager throttles `streamingParagraphs` emits at 250ms (4/sec cap),
 * so token floods don't drown React in renders.
 */
export function useBookTransformState(): BookTransformState {
  return useSyncExternalStore(bookTransformManager.subscribe, bookTransformManager.getState)
}

/** Convenience: true while a transform job is running (or tearing down after pause/cancel). */
export function isTransformActive(state: BookTransformState): boolean {
  return state.type === 'running' || state.type === 'paused'
}
