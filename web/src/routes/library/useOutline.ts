import { useCallback, useRef, useState } from 'react'
import { useDatasource } from '../../context/datasource'
import type { AiOutlineChapter } from '../../lib/ai/types'

import { parseInWorker } from '../../lib/parse/client'
import { OriginalUnavailableError } from '../../lib/reprocess'
import type { BookId, Chapter } from '../../types'
import { newChapterId } from '../../types'

/**
 * Variant state for an outline-detection run.
 * - `idle`: nothing running.
 * - `running`: re-parsing + persisting in flight.
 * - `done`: completed; `message` is the toast copy.
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
   * Re-parse the book's original file, then ask the AI engine to detect
   * chapter headings from the flat paragraph list. Replaces stored chapters
   * and resets the reading position to the start. Returns `true` if chapters
   * changed.
   *
   * M10: this is the only fallback when a PDF has no embedded outline. The
   * pre-M10 heuristic detector (`lib/outline/detect.ts`) was removed — see
   * ADR-0008.
   */
  runWithAi: (
    bookId: BookId,
    detect: (paragraphs: string[]) => Promise<AiOutlineChapter[]>,
  ) => Promise<boolean>
  /**
   * M10: re-parse the book's original file and apply the PDF's embedded outline
   * (pdfjs `getOutline`) directly — no detection step. Use this to revert
   * to the source-of-truth outline after an AI override, or to re-trigger
   * Tier 1 after a parser update.
   *
   * Reports `done` with a "no embedded outline" message when the PDF has no
   * usable Tier-1 data; the book is unchanged.
   */
  runWithPdfOutline: (bookId: BookId) => Promise<boolean>
  /** Return to idle — used to dismiss a done/error banner. */
  reset: () => void
}

/**
 * Container hook for outline regeneration. M10 onwards offers two paths:
 *
 * - **Tier 1 (pdfjs `getOutline`)** via {@link runWithPdfOutline} — applies the
 *   PDF's author-declared bookmark tree directly. Authoritative when present.
 * - **AI** via {@link runWithAi} — the only fallback when Tier 1 returns null.
 *
 * The pre-M10 heuristic detector (`lib/outline/detect.ts`) was removed per
 * ADR-0008: its keyword/numeric/font-size heuristics produced too many false
 * positives on real fiction PDFs (`"Part of the reason"`, drop caps, running
 * page headers), and AI understanding of prose context is strictly better.
 *
 * The hook re-parses the original uploaded file (source of truth — gotcha #2
 * in AGENTS.md) on every run.
 */
export function useOutline(): UseOutline {
  const { library } = useDatasource()
  const [state, setState] = useState<OutlineState>({ type: 'idle' })
  const runningRef = useRef(false)

  const runWithAi = useCallback(
    async (
      bookId: BookId,
      detect: (paragraphs: string[]) => Promise<AiOutlineChapter[]>,
    ): Promise<boolean> => {
      if (runningRef.current) return false
      runningRef.current = true
      setState({ type: 'running' })
      try {
        const stored = await library.getBookFile(bookId)
        if (!stored) throw new OriginalUnavailableError()
        const file = new File([stored.blob], stored.name, { type: stored.type })
        const result = await parseInWorker(file)

        // Flatten multi-chapter Tier-1 PDF output so AI sees one paragraph list.
        const paragraphs: string[] = []
        for (const c of result.chapters) paragraphs.push(...c.paragraphs)
        if (paragraphs.length === 0) {
          setState({ type: 'done', message: 'No text to analyze.' })
          return false
        }

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

        await library.replaceBookChapters(bookId, newChapters)
        await library.updateBookProgress(bookId, { chapterIndex: 0, paragraphIndex: 0 }, 0)

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
    [library],
  )

  const runWithPdfOutline = useCallback(
    async (bookId: BookId): Promise<boolean> => {
      if (runningRef.current) return false
      runningRef.current = true
      setState({ type: 'running' })
      try {
        const stored = await library.getBookFile(bookId)
        if (!stored) throw new OriginalUnavailableError()
        const file = new File([stored.blob], stored.name, { type: stored.type })
        const result = await parseInWorker(file)

        if (result.chapters.length < 2) {
          setState({
            type: 'done',
            message: 'PDF has no embedded outline — try AI instead.',
          })
          return false
        }

        const newChapters: Chapter[] = result.chapters.map((parsed, index) => ({
          id: newChapterId(),
          bookId,
          index,
          title: parsed.title,
          paragraphs: parsed.paragraphs,
        }))

        await library.replaceBookChapters(bookId, newChapters)
        await library.updateBookProgress(bookId, { chapterIndex: 0, paragraphIndex: 0 }, 0)

        setState({
          type: 'done',
          message: `PDF outline applied — ${newChapters.length} chapters.`,
        })
        return true
      } catch (e) {
        setState({
          type: 'error',
          message: e instanceof Error ? e.message : 'PDF outline extraction failed.',
        })
        return false
      } finally {
        runningRef.current = false
      }
    },
    [library],
  )

  const reset = useCallback(() => setState({ type: 'idle' }), [])

  return { state, runWithAi, runWithPdfOutline, reset }
}
