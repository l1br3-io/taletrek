import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaQuery } from './useMediaQuery'

describe('useMediaQuery', () => {
  const original = window.matchMedia
  afterEach(() => {
    window.matchMedia = original
  })

  it('returns false when matchMedia is unavailable', () => {
    // @ts-expect-error deliberate deletion for the test
    delete window.matchMedia
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'))
    expect(result.current).toBe(false)
  })

  it('reflects whether the query matches', () => {
    const mql: MediaQueryList = {
      matches: true,
      media: '(min-width: 640px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'))
    expect(result.current).toBe(true)
  })
})
