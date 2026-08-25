import { useSyncExternalStore } from 'react'
import { localSynthPipeline } from '../datasource'
import type { JobState } from './manager'

/**
 * Subscribe to the global upload-manager job state from React. Backed by
 * `useSyncExternalStore` so only components that actually read the job state
 * re-render on progress ticks — the rest of the tree is untouched (unlike
 * Context, which would re-render every consumer).
 *
 * The subscription goes through the datasource pipeline wrapper
 * (`localSynthPipeline`), whose `subscribe`/`getState` are the manager's
 * bound arrow properties — stable references across renders (required by
 * `useSyncExternalStore`, no re-subscribe churn).
 */
export function useUploadState(): JobState {
  return useSyncExternalStore(localSynthPipeline.subscribe, localSynthPipeline.getState)
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
