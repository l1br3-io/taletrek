import { useCallback, useRef, useState } from 'react'
import type { AiTransformEngine, PronunciationCandidate } from '../lib/ai/types'
import { getChaptersByBook } from '../lib/db'
import type { BookId } from '../types'

/**
 * Variant state for a pronunciation-hints scan.
 * - `idle`: nothing scanned (also the reset state after accept/close/abort).
 * - `loading`: fetching chapters + running the hints scan.
 * - `ready`: candidates available for review.
 * - `error`: the scan failed (not an abort).
 */
export type HintsScanState =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'ready'; candidates: PronunciationCandidate[] }
  | { type: 'error'; message: string }

export interface UsePronunciationHints {
  state: HintsScanState
  /** Scan the first chapter of `bookId` for pronunciation candidates. */
  scan: (bookId: BookId) => Promise<void>
  /** Abort any in-flight scan + return to idle. */
  reset: () => void
}

/**
 * Scans a book's opening chapter for pronunciation candidates via the engine's
 * `proposePronunciationHints`. The engine is injected by the caller; when `null`
 * (AI disabled), `scan` surfaces an error. Supports abort via the internal
 * `AbortController` (bridge to the engine's `signal`).
 */
export function usePronunciationHints(engine: AiTransformEngine | null): UsePronunciationHints {
  const [state, setState] = useState<HintsScanState>({ type: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setState({ type: 'idle' })
  }, [])

  const scan = useCallback(
    async (bookId: BookId) => {
      if (!engine) {
        setState({ type: 'error', message: 'AI is not enabled — open Settings → AI.' })
        return
      }
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setState({ type: 'loading' })
      try {
        const chapters = await getChaptersByBook(bookId)
        const sample = chapters[0]?.paragraphs ?? []
        if (controller.signal.aborted) return
        const candidates = await engine.proposePronunciationHints(
          sample,
          undefined,
          controller.signal,
        )
        if (controller.signal.aborted) return
        setState({ type: 'ready', candidates })
      } catch (e) {
        if (controller.signal.aborted) setState({ type: 'idle' })
        else setState({ type: 'error', message: (e as Error).message || 'Hints scan failed.' })
      } finally {
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    [engine],
  )

  return { state, scan, reset }
}
