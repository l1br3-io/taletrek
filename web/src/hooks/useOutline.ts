import { useCallback, useRef, useState } from 'react'
import type { AiOutlineChapter } from '../lib/ai/types'
import { getBookFile, replaceBookChapters, updateBookProgress } from '../lib/db'
import { detectOutline } from '../lib/outline/detect'
import { parseInWorker } from '../lib/parse/client'
import { OriginalUnavailableError } from '../lib/reprocess'
import type { BookId, Chapter } from '../types'
import { newChapterId } from '../types'

/**
 * Variant state for an outline-detection run.
 * - `idle`: nothing running.
 * - `running`: re-parsing + detecting + persisting in flight.
 * - `done`: completed; `message` is the toast copy (includes detection count
 *   or a "no headings found" note).
 * - `error`: the run failed (e.g. original file evicted).
 */
export type OutlineState =
  | { type: 'idle' }
  | { type: 'running' }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string }

export interface UseOutline {
  state: OutlineState
  /**
   * Re-parse the book's original file, detect chapter headings deterministically,
   * and replace the stored chapter structure. Resets the reading position to the
   * start. Reports "no headings" as `done` (not `error`) — the book is unchanged.
   * Returns `true` when chapters were re-segmented, `false` otherwise.
   */
  run: (bookId: BookId) => Promise<boolean>
  /**
   * Re-parse the book's original file, then ask the AI engine to detect chapter
   * headings from the flat paragraph list. Same post-processing as {@link run}
   * (replace chapters, reset position). Returns `true` if chapters changed.
   */
  runWithAi: (
    bookId: BookId,
    detect: (paragraphs: string[]) => Promise<AiOutlineChapter[]>,
  ) => Promise<boolean>
  /** Return to idle — used to dismiss a done/error banner. */
  reset: () => void
}

/**
 * Container hook for deterministic outline regeneration. Re-parses the
 * original uploaded file (source of truth — gotcha #2 in AGENTS.md), runs
 * {@link detectOutline} on the fresh single-chapter parse, and if headings are
 * found, atomically replaces all chapters + resets position to chapter 0.
 *
 * No AI dependency — works fully offline. See `docs/prds/` for the outline
 * transform spec.
 */
export function useOutline(): UseOutline {
  const [state, setState] = useState<OutlineState>({ type: 'idle' })
  const runningRef = useRef(false)

  const run = useCallback(async (bookId: BookId): Promise<boolean> => {
    if (runningRef.current) return false
    runningRef.current = true
    setState({ type: 'running' })
    try {
      const stored = await getBookFile(bookId)
      if (!stored) throw new OriginalUnavailableError()
      const file = new File([stored.blob], stored.name, { type: stored.type })
      const result = await parseInWorker(file)

      const detection = detectOutline(result.chapters)
      if (!detection.detected) {
        setState({
          type: 'done',
          message: 'No chapter headings detected — the book stays as-is.',
        })
        return false
      }

      const newChapters: Chapter[] = detection.chapters.map((parsed, index) => {
        const heads = detection.headings[index]
        return {
          id: newChapterId(),
          bookId,
          index,
          title: parsed.title,
          paragraphs: parsed.paragraphs,
          headings: heads && heads.length > 0 ? heads : undefined,
        }
      })

      await replaceBookChapters(bookId, newChapters)
      await updateBookProgress(bookId, { chapterIndex: 0, paragraphIndex: 0 }, 0)

      setState({
        type: 'done',
        message: `Outline generated — ${newChapters.length} chapters detected.`,
      })
      return true
    } catch (e) {
      setState({
        type: 'error',
        message: e instanceof Error ? e.message : 'Outline generation failed.',
      })
      return false
    } finally {
      runningRef.current = false
    }
  }, [])

  const runWithAi = useCallback(
    async (
      bookId: BookId,
      detect: (paragraphs: string[]) => Promise<AiOutlineChapter[]>,
    ): Promise<boolean> => {
      if (runningRef.current) return false
      runningRef.current = true
      setState({ type: 'running' })
      try {
        const stored = await getBookFile(bookId)
        if (!stored) throw new OriginalUnavailableError()
        const file = new File([stored.blob], stored.name, { type: stored.type })
        const result = await parseInWorker(file)

        const flat = result.chapters[0]
        if (!flat) {
          setState({ type: 'done', message: 'No text to analyze.' })
          return false
        }
        const paragraphs = flat.paragraphs
        const boundaries = await detect(paragraphs)

        if (boundaries.length === 0) {
          setState({
            type: 'done',
            message: 'AI found no chapter headings — the book stays as-is.',
          })
          return false
        }

        const sorted = [...boundaries].sort((a, b) => a.paragraphIndex - b.paragraphIndex)
        const newChapters: Chapter[] = []
        for (let i = 0; i < sorted.length; i++) {
          const start = sorted[i]?.paragraphIndex ?? 0
          const end = sorted[i + 1]?.paragraphIndex ?? paragraphs.length
          newChapters.push({
            id: newChapterId(),
            bookId,
            index: i,
            title: sorted[i]?.title ?? `Chapter ${i + 1}`,
            paragraphs: paragraphs.slice(start, end),
          })
        }

        await replaceBookChapters(bookId, newChapters)
        await updateBookProgress(bookId, { chapterIndex: 0, paragraphIndex: 0 }, 0)

        setState({
          type: 'done',
          message: `AI outline generated — ${newChapters.length} chapters detected.`,
        })
        return true
      } catch (e) {
        setState({
          type: 'error',
          message: e instanceof Error ? e.message : 'AI outline generation failed.',
        })
        return false
      } finally {
        runningRef.current = false
      }
    },
    [],
  )

  const reset = useCallback(() => setState({ type: 'idle' }), [])

  return { state, run, runWithAi, reset }
}
