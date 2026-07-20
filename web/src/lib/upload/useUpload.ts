import { useSyncExternalStore } from 'react'
import { type JobState, uploadManager } from './manager'

/**
 * Subscribe to the global upload-manager job state from React. Backed by
 * `useSyncExternalStore` so only components that actually read the job state
 * re-render on progress ticks — the rest of the tree is untouched (unlike
 * Context, which would re-render every consumer).
 *
 * `getState`/`subscribe` are bound arrow properties on the singleton, so the
 * references are stable across renders (required by `useSyncExternalStore`).
 */
export function useUploadState(): JobState {
  return useSyncExternalStore(uploadManager.subscribe, uploadManager.getState)
}

/** Convenience: true while a synthesis job is running (or tearing down after cancel/pause). */
export function isJobActive(state: JobState): boolean {
  return (
    state.type === 'voiceDownload' ||
    state.type === 'synthesizing' ||
    state.type === 'encoding' ||
    state.type === 'cancelling' ||
    state.type === 'pausing'
  )
}
