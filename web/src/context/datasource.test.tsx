import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  localDatasource,
  localSynthPipeline,
  serverDatasource,
  serverSynthPipeline,
} from '../lib/datasource'
import { DatasourceProvider, useDatasource } from './datasource'

describe('DatasourceProvider', () => {
  it('defaults to the local shape (standalone PWA / bare test wrap)', () => {
    const { result } = renderHook(() => useDatasource(), { wrapper: DatasourceProvider })
    expect(result.current.mode).toBe('local')
    expect(result.current.library).toBe(localDatasource)
    expect(result.current.synth).toBe(localSynthPipeline)
  })

  it('exposes the server datasource + stub pipeline in server mode', () => {
    const { result } = renderHook(() => useDatasource(), {
      wrapper: ({ children }) => <DatasourceProvider mode="server">{children}</DatasourceProvider>,
    })
    expect(result.current.mode).toBe('server')
    expect(result.current.library).toBe(serverDatasource)
    expect(result.current.synth).toBe(serverSynthPipeline)
  })

  it('value is referentially stable across renders (mode never changes)', () => {
    const { result, rerender } = renderHook(() => useDatasource(), {
      wrapper: DatasourceProvider,
    })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('throws outside a provider (wiring mistakes fail loudly)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useDatasource())).toThrow(/within <DatasourceProvider>/)
    consoleError.mockRestore()
  })
})
