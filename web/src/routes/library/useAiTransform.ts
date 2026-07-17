import { useCallback, useRef, useState } from 'react'
import type { SynthMode } from '../../context/settings'
import { getAiEngineForDef } from '../../lib/ai/client'
import type {
  AiSettings,
  AppliedProcessing,
  TransformDefinition,
  TransformOp,
} from '../../lib/ai/types'
import { deleteBookAudio } from '../../lib/book-audio'
import type { CleaningConfig } from '../../lib/clean/types'
import {
  deleteAudioCacheKeys,
  getAudioCacheKeysByBook,
  putChapters,
  updateBookProcessing,
  updateBookProgress,
} from '../../lib/db'
import { uploadManager } from '../../lib/upload/manager'
import type { Book, Chapter, VoiceId } from '../../types'

/**
 * Variant state for a transform run.
 * - `idle`: nothing running. Also the state returned to after an abort.
 * - `running`: in flight; `fraction` is 0..1 across prep + all ops × chapters.
 * - `done`: the run completed + the book was written; `message` is the toast copy.
 * - `error`: the run failed (not an abort).
 */
export type TransformState =
  | { type: 'idle' }
  | { type: 'running'; fraction: number; stage: string }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string }

export interface RunTransformsArgs {
  book: Book
  /**
   * Source chapters (upload flow). Mutually exclusive with `resolveChapters`.
   */
  chapters?: Chapter[]
  /**
   * Lazy source resolver (reprocess flow): re-parses the original file so
   * transforms start from pristine paragraphs (idempotent re-runs, not stacked
   * on prior output). Reported as a "Re-parsing original…" running stage.
   * Mutually exclusive with `chapters`.
   */
  resolveChapters?: () => Promise<Chapter[]>
  /** Selected ops, applied in order — the output of each feeds the next. */
  ops: TransformOp[]
}

export interface UseAiTransform {
  state: TransformState
  /** Run the selected ops over the book's chapters, then persist + reset position. */
  run: (args: RunTransformsArgs) => Promise<void>
  /** Abort the in-flight run (resolves to `idle`, not `error`). */
  abort: () => void
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function describeStage(defs: TransformDefinition[], ops: TransformOp[], opIndex: number): string {
  const op = ops[opIndex]
  if (!op) return ''
  const def = defs.find((d) => d.id === op.defId)
  return `${def?.label ?? 'Unknown'} (${opIndex + 1}/${ops.length})`
}

/**
 * Container hook for an AI post-process run. Chains the selected ops across
 * every chapter (each chapter transformed independently — transforms preserve
 * chapter boundaries), reports aggregate progress, supports abort, and on
 * completion writes the new `paragraphs` + an `AppliedProcessing` record +
 * resets the read position to `(chapterIndex, 0)` (M6 locked decision: keep the
 * chapter, restart its paragraphs — a transform invalidates the old
 * `paragraphIndex`; `progressFraction` resets too).
 *
 * The engine is resolved per-def via {@link getAiEngineForDef} so each
 * transform definition can pin a different provider/model.
 */
export function useAiTransform({
  ai,
  defs,
  synthMode,
  voiceId,
  cleaning,
  prepare,
}: {
  ai: AiSettings | undefined
  defs: TransformDefinition[]
  synthMode?: SynthMode
  voiceId?: VoiceId
  cleaning?: CleaningConfig
  prepare?: (onProgress: (fraction: number) => void) => Promise<void>
}): UseAiTransform {
  const [state, setState] = useState<TransformState>({ type: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const run = useCallback(
    async (args: RunTransformsArgs) => {
      const { book, ops, resolveChapters } = args
      if (ops.length === 0) return
      if (runningRef.current) return
      if (!ai?.enabled) {
        setState({ type: 'error', message: 'AI is not enabled — open Settings → AI.' })
        return
      }
      runningRef.current = true
      const controller = new AbortController()
      abortRef.current = controller
      const initialStage = prepare
        ? 'Loading model…'
        : resolveChapters
          ? 'Re-parsing original…'
          : describeStage(defs, ops, 0)
      setState({ type: 'running', fraction: 0, stage: initialStage })
      try {
        if (prepare) {
          await prepare((fraction) =>
            setState({ type: 'running', fraction, stage: 'Loading model…' }),
          )
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        }
        let working: Chapter[]
        if (resolveChapters) {
          setState({ type: 'running', fraction: 0, stage: 'Re-parsing original…' })
          working = await resolveChapters()
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          setState({ type: 'running', fraction: 0, stage: describeStage(defs, ops, 0) })
        } else {
          working = args.chapters ?? []
        }
        const numChapters = working.length
        const total = ops.length * numChapters
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i]
          if (!op) continue
          const def = defs.find((d) => d.id === op.defId)
          if (!def) {
            setState({
              type: 'error',
              message: `Transform "unknown" not found — it may have been deleted.`,
            })
            return
          }
          const engine = getAiEngineForDef(ai, def)
          if (!engine) {
            setState({
              type: 'error',
              message: `No provider configured for "${def.label}". Open Settings → AI and configure a provider.`,
            })
            return
          }
          const next: Chapter[] = []
          for (let c = 0; c < working.length; c++) {
            const chapter = working[c]
            if (!chapter) continue
            const out = await engine.transform(
              chapter.paragraphs,
              op,
              def,
              (f) => {
                const done = i * numChapters + c + clamp01(f)
                setState({
                  type: 'running',
                  fraction: total > 0 ? done / total : 0,
                  stage: describeStage(defs, ops, i),
                })
              },
              controller.signal,
            )
            next.push({ ...chapter, paragraphs: out })
          }
          working = next
          // Checkpoint after each op so a tab crash mid-run doesn't lose
          // completed ops (PRD: "long ops checkpoint to IndexedDB").
          await putChapters(working)
        }
        const processing: AppliedProcessing = {
          appliedAt: Date.now(),
          ops,
        }
        await updateBookProcessing(book.id, processing)
        const chapterIndex = book.position?.chapterIndex ?? 0
        await updateBookProgress(book.id, { chapterIndex, paragraphIndex: 0 }, 0)
        setState({
          type: 'done',
          message: `Transform applied — resumed at start of chapter ${chapterIndex + 1}.`,
        })

        // Fire-and-forget re-synthesis if synth is enabled. Transformed
        // paragraphs invalidate the content-addressed audio cache, so we
        // purge stale entries then re-synth the whole book. Uses the
        // resynth-safe mode (failure preserves the book + offers retry).
        if (synthMode && synthMode !== 'off' && voiceId && cleaning) {
          void (async () => {
            try {
              const keys = await getAudioCacheKeysByBook(book.id)
              if (keys.length > 0) await deleteAudioCacheKeys(keys)
              await deleteBookAudio(book.id)
              const latest = { ...book, updatedAt: Date.now() }
              uploadManager.startJob({
                book: latest,
                chapters: working,
                voiceId,
                cleaning,
                mode: 'resynth',
              })
            } catch {
              // Silent — banner is the primary error surface.
            }
          })()
        }
      } catch (e) {
        if (controller.signal.aborted) setState({ type: 'idle' })
        else setState({ type: 'error', message: (e as Error).message || 'Transform failed.' })
      } finally {
        runningRef.current = false
        abortRef.current = null
      }
    },
    [ai, defs, synthMode, voiceId, cleaning, prepare],
  )

  return { state, run, abort }
}
