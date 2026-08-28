/**
 * Hosted voice catalog hook (T16): `GET /api/voices` through
 * {@link fetchServerVoices}, shared by the Settings picker and the
 * library's per-book Synthesize sheet. The catalog is static per server
 * build, so a successful fetch is cached at module scope — every interested
 * surface re-renders from one request per session.
 */

import { useEffect, useState } from 'react'
import { fetchServerVoices } from '../lib/datasource'
import type { Voice } from '../lib/tts/types'

export type ServerVoicesState =
  | { type: 'loading' }
  | { type: 'ready'; voices: Voice[] }
  | { type: 'error'; message: string }

let cached: Voice[] | null = null

/** Test-only: drop the module-scope catalog cache. */
export function _resetServerVoicesCacheForTests(): void {
  cached = null
}

export function useServerVoices(): ServerVoicesState {
  const [state, setState] = useState<ServerVoicesState>(() =>
    cached ? { type: 'ready', voices: cached } : { type: 'loading' },
  )

  useEffect(() => {
    if (cached) return
    let cancelled = false
    void fetchServerVoices()
      .then((voices) => {
        cached = voices
        if (!cancelled) setState({ type: 'ready', voices })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ type: 'error', message: e instanceof Error ? e.message : 'network error' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
