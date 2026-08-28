import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { Voice } from '../lib/tts/types'
import { voiceId } from '../types'
import { _resetServerVoicesCacheForTests, useServerVoices } from './useServerVoices'

vi.mock('../lib/datasource', () => ({
  fetchServerVoices: (...args: unknown[]) => fetchMock(...args),
}))

const fetchMock: Mock = vi.fn<() => Promise<Voice[]>>()

const VOICES: Voice[] = [
  {
    id: voiceId('en_US-hfc_female-medium'),
    name: 'HFC Female',
    quality: 'medium',
    sizeBytes: 1,
    language: 'en_US',
  },
]

describe('useServerVoices', () => {
  afterEach(() => {
    _resetServerVoicesCacheForTests()
    vi.clearAllMocks()
  })

  it('loads the catalog once and caches it for later mounts', async () => {
    fetchMock.mockResolvedValue(VOICES)
    const first = renderHook(() => useServerVoices())
    await waitFor(() => expect(first.result.current.type).toBe('ready'))
    if (first.result.current.type === 'ready') {
      expect(first.result.current.voices).toEqual(VOICES)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = renderHook(() => useServerVoices())
    expect(second.result.current.type).toBe('ready') // served from cache
    expect(fetchMock).toHaveBeenCalledTimes(1)
    first.unmount()
    second.unmount()
  })

  it('surfaces fetch failures as the error variant', async () => {
    fetchMock.mockRejectedValue(new Error('server down'))
    const { result } = renderHook(() => useServerVoices())
    await waitFor(() => expect(result.current.type).toBe('error'))
    if (result.current.type === 'error') {
      expect(result.current.message).toBe('server down')
    }
  })

  it('starts in loading before the fetch resolves', async () => {
    let resolveFetch: (v: Voice[]) => void = () => {}
    fetchMock.mockReturnValue(
      new Promise<Voice[]>((resolve) => {
        resolveFetch = resolve
      }),
    )
    const { result } = renderHook(() => useServerVoices())
    expect(result.current.type).toBe('loading')
    await act(async () => {
      resolveFetch([])
    })
    expect(result.current.type).toBe('ready')
  })
})
