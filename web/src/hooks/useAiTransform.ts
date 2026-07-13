import { useCallback, useRef, useState } from 'react'
import type {
  AiTransformEngine,
  AppliedProcessing,
  TransformOp,
  TransformParams,
} from '../lib/ai/types'
import { putChapters, updateBookProcessing, updateBookProgress } from '../lib/db'
import type { Book, Chapter } from '../types'

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

const OP_LABELS: Record<TransformOp['kind'], string> = {
  cleanup: 'Clean up',
  translate: 'Translate',
  summarize: 'Summarize',
  simplify: 'Simplify',
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function describeStage(ops: TransformOp[], opIndex: number): string {
  const op = ops[opIndex]
  if (!op) return ''
  return `${OP_LABELS[op.kind]} (${opIndex + 1}/${ops.length})`
}

/** Fold the selected ops' params into the {@link AppliedProcessing.params} shape. */
function extractParams(ops: TransformOp[]): TransformParams {
  const p: TransformParams = {}
  for (const op of ops) {
    if (op.kind === 'translate') p.translate = { target: op.target }
    else if (op.kind === 'summarize') p.summarize = { ratio: op.ratio }
    else if (op.kind === 'simplify') p.simplify = { level: op.level }
  }
  return p
}

export interface UseAiTransformOptions {
  /** The engine resolved by the caller (`null` when AI is disabled — `run` errors). */
  engine: AiTransformEngine | null
  /**
   * Optional prep step run before transforms. Its progress is reported as a
   * "Loading model…" running stage so the modal shows one continuous progress
   * bar. Unused now that only the cloud backend remains; retained for future
   * backends that need a warm-up step.
   */
  prepare?: (onProgress: (fraction: number) => void) => Promise<void>
}

/**
 * Container hook for an AI post-process run. Chains the selected ops across
 * every chapter (each chapter transformed independently — transforms preserve
 * chapter boundaries), reports aggregate progress, supports abort, and on
 * completion writes the new `paragraphs` + an `AppliedProcessing` record +
 * resets the read position to `(chapterIndex, 0)` (M6 locked decision: keep the
 * chapter, restart its paragraphs — a transform invalidates the old
 * `paragraphIndex`; `progressFraction` resets too). The key never lives in
 * Settings (ADR-0004); the engine resolves it via `keyring`.
 *
 * The engine is injected (+ an optional `prepare`) so the caller controls
 * creation; the hook only runs the work.
 */
export function useAiTransform({ engine, prepare }: UseAiTransformOptions): UseAiTransform {
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
      if (!engine) {
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
          : describeStage(ops, 0)
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
          setState({ type: 'running', fraction: 0, stage: describeStage(ops, 0) })
        } else {
          working = args.chapters ?? []
        }
        const numChapters = working.length
        const total = ops.length * numChapters
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i]
          if (!op) continue
          const next: Chapter[] = []
          for (let c = 0; c < working.length; c++) {
            const chapter = working[c]
            if (!chapter) continue
            const out = await engine.transform(
              chapter.paragraphs,
              op,
              (f) => {
                const done = i * numChapters + c + clamp01(f)
                setState({
                  type: 'running',
                  fraction: total > 0 ? done / total : 0,
                  stage: describeStage(ops, i),
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
          transforms: ops.map((o) => o.kind),
          params: extractParams(ops),
        }
        await updateBookProcessing(book.id, processing)
        const chapterIndex = book.position?.chapterIndex ?? 0
        await updateBookProgress(book.id, { chapterIndex, paragraphIndex: 0 }, 0)
        setState({
          type: 'done',
          message: `Transform applied — resumed at start of chapter ${chapterIndex + 1}.`,
        })
      } catch (e) {
        if (controller.signal.aborted) setState({ type: 'idle' })
        else setState({ type: 'error', message: (e as Error).message || 'Transform failed.' })
      } finally {
        runningRef.current = false
        abortRef.current = null
      }
    },
    [engine, prepare],
  )

  return { state, run, abort }
}
