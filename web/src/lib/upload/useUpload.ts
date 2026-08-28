import { useSyncExternalStore } from 'react'
import { type JobState, localSynthPipeline, type SynthPipeline } from '../datasource'

/**
 * Subscribe to the upload-manager job state from React. Backed by
 * `useSyncExternalStore` so only components that actually read the job state
 * re-render on progress ticks — the rest of the tree is untouched (unlike
 * Context, which would re-render every consumer).
 *
 * The pipeline is injectable: UI callers pass the boot-resolved one from
 * `useDatasource()` (local or server shape — both expose stable
 * `subscribe`/`getState` references, required by `useSyncExternalStore`).
 * The default is the local singleton, which keeps lib-level consumers and
 * tests working unchanged.
 */
export function useUploadState(pipeline: SynthPipeline = localSynthPipeline): JobState {
  return useSyncExternalStore(pipeline.subscribe, pipeline.getState)
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
