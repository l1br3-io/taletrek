/**
 * Shared transform/hints orchestration — engine-agnostic.
 *
 * Both backends supply a {@link CompleteFn} that turns prompt messages into a
 * single completion string (cloud: `fetch`+SSE; in-browser: WebLLM's streaming
 * `chat.completions.create`). This module owns the per-op chunking loop,
 * reassembly policy, and progress reporting — extracted so the two engines
 * never drift. See `docs/prds/M6-ai-transforms.md` §Architecture.
 */

import { chunksForOp, sample as sampleParagraphs } from './chunk'
import {
  buildHintsMessages,
  buildTransformMessages,
  type CompletionMessages,
  parseHintCandidates,
  splitOutput,
} from './prompts'
import type { PronunciationCandidate, TransformOp } from './types'

/** Engine-specific completion primitive. */
export type CompleteFn = (
  messages: CompletionMessages,
  opts?: { json?: boolean; signal?: AbortSignal },
) => Promise<string>

/** Progress fraction, treating an empty chunk list as already complete. */
function fraction(done: number, total: number): number {
  return total === 0 ? 1 : done / total
}

/**
 * Run a transform op over the input paragraphs.
 *
 * - `summarize`: disjoint windows (overlap=0, see `chunk.chunksForOp`); each
 *   window's condensed paragraphs are appended.
 * - cleanup/translate/simplify: count-preserving; starts from the originals so a
 *   paragraph the model under-delivers keeps its text (never drops content).
 *   Overlap regions use last-write-wins.
 */
export async function runTransform(
  input: string[],
  op: TransformOp,
  complete: CompleteFn,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  const chunks = chunksForOp(op, input)

  if (op.kind === 'summarize') {
    const out: string[] = []
    for (const [i, chunk] of chunks.entries()) {
      const raw = await complete(buildTransformMessages(op, chunk.paragraphs), { signal })
      out.push(...splitOutput(raw))
      onProgress?.(fraction(i + 1, chunks.length))
    }
    return out
  }

  const out = [...input]
  for (const [i, chunk] of chunks.entries()) {
    const raw = await complete(buildTransformMessages(op, chunk.paragraphs), { signal })
    const parts = splitOutput(raw)
    for (let j = 0; j < parts.length; j++) {
      const idx = chunk.start + j
      if (idx < out.length) out[idx] = parts[j] ?? out[idx] ?? ''
    }
    onProgress?.(fraction(i + 1, chunks.length))
  }
  return out
}

/** Run a pronunciation-hints scan over the opening sample of a book. */
export async function runHints(
  sample: string[],
  complete: CompleteFn,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<PronunciationCandidate[]> {
  const chunk = sampleParagraphs(sample)
  const raw = await complete(buildHintsMessages(chunk.paragraphs), { json: true, signal })
  onProgress?.(1)
  return parseHintCandidates(raw)
}
