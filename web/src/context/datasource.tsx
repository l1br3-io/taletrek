import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { type LibraryDatasource, localDatasource } from '../lib/datasource'

/**
 * Low-frequency context carrying the library datasource. Since the native
 * pivot (ADR-0015) there is exactly one implementation — the local
 * IndexedDB one — kept behind the seam so a future host (sync server,
 * native shell) can slot in without touching callers. Context is correct
 * here precisely because this is set-at-boot configuration, **never**
 * playback or job-progress state.
 */

export interface DatasourceContextValue {
  library: LibraryDatasource
}

const DatasourceContext = createContext<DatasourceContextValue | null>(null)

export function DatasourceProvider({
  children,
  library = localDatasource,
}: {
  children: ReactNode
  /** Override point for tests; production always uses the local reader. */
  library?: LibraryDatasource
}) {
  const value = useMemo<DatasourceContextValue>(() => ({ library }), [library])

  return <DatasourceContext.Provider value={value}>{children}</DatasourceContext.Provider>
}

export function useDatasource(): DatasourceContextValue {
  const ctx = useContext(DatasourceContext)
  if (!ctx) throw new Error('useDatasource must be used within <DatasourceProvider>')
  return ctx
}
