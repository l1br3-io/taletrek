import { createContext, type ReactNode, useContext, useMemo } from 'react'
import {
  type DatasourceMode,
  type LibraryDatasource,
  localDatasource,
  localSynthPipeline,
  type SynthPipeline,
  serverDatasource,
  serverSynthPipeline,
} from '../lib/datasource'

/**
 * Low-frequency context carrying the boot-resolved datasource (ADR-0014,
 * Effort 5 · T13). The mode is decided once by `resolve.ts` before React
 * mounts and never changes — Context is correct here precisely because this
 * is set-at-boot configuration, **never** playback or job-progress state
 * (those stay in external stores; see `useUploadState`).
 *
 * UI contract: read `library` / `synth` for every data access — never branch
 * on `mode` for data. `mode` exists for affordance toggling only (T16 hides
 * local-only affordances like on-device synth settings when hosted).
 *
 * `mode` defaults to `'local'` so test harnesses can wrap bare
 * `<DatasourceProvider>`; `main.tsx` passes the boot-resolved value.
 */

export interface DatasourceContextValue {
  mode: DatasourceMode
  library: LibraryDatasource
  synth: SynthPipeline
}

const DatasourceContext = createContext<DatasourceContextValue | null>(null)

export function DatasourceProvider({
  mode = 'local',
  children,
}: {
  mode?: DatasourceMode
  children: ReactNode
}) {
  const value = useMemo<DatasourceContextValue>(() => {
    if (mode === 'server') {
      return { mode, library: serverDatasource, synth: serverSynthPipeline }
    }
    return { mode, library: localDatasource, synth: localSynthPipeline }
  }, [mode])

  return <DatasourceContext.Provider value={value}>{children}</DatasourceContext.Provider>
}

export function useDatasource(): DatasourceContextValue {
  const ctx = useContext(DatasourceContext)
  if (!ctx) throw new Error('useDatasource must be used within <DatasourceProvider>')
  return ctx
}
