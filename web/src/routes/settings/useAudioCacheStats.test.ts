import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DatasourceProvider } from '../../context/datasource'
import { _clearDBForTests, _resetDBForTests, putAudioCacheEntry } from '../../lib/db'
import { type AudioCacheRecord, newBookId, voiceId } from '../../types'
import { useAudioCacheStats } from './useAudioCacheStats'

/** renderHook with the (default-local) DatasourceProvider mounted. */
function renderHookWithDs<T>(fn: () => T) {
  return renderHook(fn, { wrapper: DatasourceProvider })
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

function makeRecord(sizeBytes: number): AudioCacheRecord {
  return {
    key: `k-${Math.random()}`,
    blob: new Blob(['x']),
    sizeBytes,
    synthMs: 1,
    durationSeconds: 1,
    voiceId: voiceId('en_US-hfc_female-medium'),
    lastUsed: Date.now(),
    createdAt: Date.now(),
    bookId: newBookId(),
  }
}

describe('useAudioCacheStats', () => {
  it('reads the cache size on mount', async () => {
    await putAudioCacheEntry(makeRecord(100))
    await putAudioCacheEntry(makeRecord(250))
    const { result } = renderHookWithDs(() => useAudioCacheStats())
    await waitFor(() => expect(result.current.sizeBytes).toBe(350))
  })

  it('reports null when the cache is empty', async () => {
    const { result } = renderHookWithDs(() => useAudioCacheStats())
    await waitFor(() => expect(result.current.sizeBytes).toBe(0))
  })

  it('refresh() picks up entries added after mount', async () => {
    const { result } = renderHookWithDs(() => useAudioCacheStats())
    await waitFor(() => expect(result.current.sizeBytes).toBe(0))
    await putAudioCacheEntry(makeRecord(500))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.sizeBytes).toBe(500)
  })
})
