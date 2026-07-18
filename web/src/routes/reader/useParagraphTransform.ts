import { useCallback, useMemo, useRef, useState } from 'react'
import type { SynthMode } from '../../context/settings'
import { getAiEngineForDef } from '../../lib/ai/client'
import type { AiSettings, TransformOp } from '../../lib/ai/types'
import { cleanParagraphsWithOrigins } from '../../lib/clean'
import type { CleaningConfig } from '../../lib/clean/types'
import { applyDeterministicOp, type DeterministicOp } from '../../lib/transforms/deterministic'
import { ttsClient } from '../../lib/tts/client'
import type { BookId, Chapter, ChapterId, VoiceId } from '../../types'
import type { ParagraphRef } from './players/types'

interface UseParagraphTransformArgs {
  currentParagraphId: string | null
  chapters: Chapter[]
  cleanedParagraphs: ParagraphRef[]
  cleaning: CleaningConfig
  ai: AiSettings | undefined
  synthMode: SynthMode
  voiceId: VoiceId
  online: boolean
  bookId: BookId
  onParagraphChanged: (chapterId: ChapterId, rawParagraphIndex: number, text: string) => void
  onPause: () => void
}

interface ResolvedTarget {
  chapterId: ChapterId
  rawParagraphIndex: number
  rawText: string
}

/**
 * Live AI-stream state surfaced to the reader for in-place rendering.
 * `null` when no stream is in flight; an object (possibly with empty
 * `streamingText` while waiting for the first token) while streaming.
 */
export interface StreamState {
  /** Positional paragraph id (`${chapterId}:${cleanedIdx}`) being rewritten. */
  paragraphId: string
  /** Def label for the eyebrow (`❯ simplify`). */
  opLabel: string
  /** Accumulated text-so-far (chunk-local; resets between chunks). */
  streamingText: string
}

/**
 * Per-paragraph transform logic (F8). Transforms edit the RAW source paragraph
 * (source of truth); cleaning re-derives the displayed text. The cleaned→raw
 * mapping comes from `cleanParagraphsWithOrigins`, which mirrors the read-time
 * cleaning exactly. Owns the transform modal state, undo stack, both the
 * deterministic + AI transform pipelines, and the live AI-stream state for
 * in-place rendering.
 */
export function useParagraphTransform({
  currentParagraphId,
  chapters,
  cleanedParagraphs,
  cleaning,
  ai,
  synthMode,
  voiceId,
  online,
  bookId,
  onParagraphChanged,
  onPause,
}: UseParagraphTransformArgs) {
  const [transformOpen, setTransformOpen] = useState(false)
  const [transformError, setTransformError] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const [stream, setStream] = useState<StreamState | null>(null)
  const undoStackRef = useRef<
    Array<{ chapterId: ChapterId; rawParagraphIndex: number; prevText: string }>
  >([])
  // AbortController for the in-flight AI request. Ref (not state) because it's
  // a stable identity we mutate imperatively; the component doesn't re-render
  // on assignment, only on stream-text changes.
  const abortRef = useRef<AbortController | null>(null)

  const targetPreview = useMemo(() => {
    if (!currentParagraphId) return ''
    return cleanedParagraphs.find((p) => p.id === currentParagraphId)?.text ?? ''
  }, [currentParagraphId, cleanedParagraphs])

  const resolveTarget = useCallback((): ResolvedTarget | null => {
    if (!currentParagraphId) return null
    const sep = currentParagraphId.lastIndexOf(':')
    const chapterIdStr = currentParagraphId.slice(0, sep)
    const cleanedIdx = Number(currentParagraphId.slice(sep + 1))
    const chapter = chapters.find((c) => c.id === chapterIdStr)
    if (!chapter) return null
    const origin = cleanParagraphsWithOrigins(chapter.paragraphs, cleaning)[cleanedIdx]
    if (!origin) return null
    return {
      chapterId: chapter.id,
      rawParagraphIndex: origin.rawIndex,
      rawText: chapter.paragraphs[origin.rawIndex] ?? '',
    }
  }, [currentParagraphId, chapters, cleaning])

  // Auto re-synth: when a paragraph is transformed (F8) and synth mode is not
  // 'off', fire-and-forget a synthesis of the new text so the cache stays
  // populated for the power-user flow. Silent + best-effort.
  const resynthParagraph = useCallback(
    (text: string) => {
      if (synthMode === 'off') return
      if (!text.trim()) return
      void ttsClient.synthesize({ text, voiceId, bookId })
    },
    [synthMode, voiceId, bookId],
  )

  const commitTransform = useCallback(
    (chapterId: ChapterId, rawParagraphIndex: number, prevText: string, nextText: string) => {
      if (nextText === prevText) return
      undoStackRef.current.push({ chapterId, rawParagraphIndex, prevText })
      setUndoCount(undoStackRef.current.length)
      onParagraphChanged(chapterId, rawParagraphIndex, nextText)
      resynthParagraph(nextText)
    },
    [onParagraphChanged, resynthParagraph],
  )

  const applyDet = useCallback(
    (op: DeterministicOp) => {
      setTransformError(null)
      const target = resolveTarget()
      if (!target) {
        setTransformError('No paragraph selected — tap a paragraph first.')
        return
      }
      commitTransform(
        target.chapterId,
        target.rawParagraphIndex,
        target.rawText,
        applyDeterministicOp(target.rawText, op),
      )
    },
    [resolveTarget, commitTransform],
  )

  const applyAi = useCallback(
    async (op: TransformOp) => {
      setTransformError(null)
      const target = resolveTarget()
      if (!target) {
        setTransformError('No paragraph selected — tap a paragraph first.')
        return
      }
      if (!ai?.enabled) {
        setTransformError('Enable AI transforms in Settings first.')
        return
      }
      if (!online) {
        setTransformError('AI requires an internet connection.')
        return
      }
      const def = ai.transformDefs.find((d) => d.id === op.defId)
      if (!def) {
        setTransformError('Transform definition not found — it may have been deleted.')
        return
      }
      const engine = getAiEngineForDef(ai, def)
      if (!engine) {
        setTransformError('No cloud provider configured — add one in Settings.')
        return
      }
      const ready = await engine.isReady()
      if (!ready) {
        setTransformError('Set your API key in Settings → AI.')
        return
      }
      // Close the modal + drop focus so any open mobile keyboard dismisses.
      // The rewrite streams in-place on the paragraph — modal would be a wall.
      setTransformOpen(false)
      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      // Fresh AbortController for this run; supersedes any dangling one.
      const controller = new AbortController()
      abortRef.current = controller
      setStream({
        paragraphId: currentParagraphId ?? '',
        opLabel: def.label,
        streamingText: '',
      })
      setAiBusy(true)
      try {
        const [out] = await engine.transform(
          [target.rawText],
          op,
          def,
          /* onProgress */ undefined,
          controller.signal,
          (textSoFar) => {
            // Throttle re-renders to animation frames so a flood of small
            // tokens (e.g. GPT-4o single-char deltas) doesn't pin the main
            // thread. textSoFar replaces the chunk-local accumulator.
            setStream((prev) =>
              prev && prev.streamingText !== textSoFar
                ? { ...prev, streamingText: textSoFar }
                : prev,
            )
          },
        )
        if (!out?.trim()) throw new Error('AI returned an empty result.')
        commitTransform(target.chapterId, target.rawParagraphIndex, target.rawText, out.trim())
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          // User-initiated stop — silent recovery, no error surface.
        } else {
          setTransformError(e instanceof Error ? e.message : 'AI transform failed.')
        }
      } finally {
        abortRef.current = null
        setStream(null)
        setAiBusy(false)
      }
    },
    [resolveTarget, commitTransform, ai, online, currentParagraphId],
  )

  /** Abort the in-flight AI stream. Discards partial text; no commit. */
  const stopAi = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleUndo = useCallback(() => {
    const last = undoStackRef.current.pop()
    if (!last) return
    setUndoCount(undoStackRef.current.length)
    onParagraphChanged(last.chapterId, last.rawParagraphIndex, last.prevText)
    resynthParagraph(last.prevText)
  }, [onParagraphChanged, resynthParagraph])

  const openTransform = useCallback(() => {
    setTransformError(null)
    onPause()
    setTransformOpen(true)
  }, [onPause])

  return {
    transformOpen,
    setTransformOpen,
    transformError,
    aiBusy,
    undoCount,
    targetPreview,
    stream,
    applyDet,
    applyAi,
    stopAi,
    handleUndo,
    openTransform,
  }
}
