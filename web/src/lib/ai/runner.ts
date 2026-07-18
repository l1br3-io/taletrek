/**
 * Shared transform/hints orchestration — engine-agnostic.
 *
 * The cloud backend supplies a {@link CompleteFn} that turns prompt messages
 * into a single completion string (`fetch` + SSE). This module owns the per-op
 * chunking loop, reassembly policy, progress reporting, and inter-request
 * throttling.
 */

import { chunksForParagraphs, estimateTokens, sample as sampleParagraphs } from './chunk'
import {
  buildHintsMessages,
  buildOutlineMessages,
  buildTransformMessages,
  type CompletionMessages,
  parseHintCandidates,
  parseOutlineCandidates,
  splitOutput,
} from './prompts'
import type {
  AiOutlineChapter,
  AppliedProcessing,
  PronunciationCandidate,
  TransformDefinition,
  TransformOp,
} from './types'

/** Engine-specific completion primitive. */
export type CompleteFn = (
  messages: CompletionMessages,
  opts?: {
    json?: boolean
    signal?: AbortSignal
    onDelta?: (textSoFar: string, delta: string) => void
  },
) => Promise<string>

/** Progress fraction, treating an empty chunk list as already complete. */
function fraction(done: number, total: number): number {
  return total === 0 ? 1 : done / total
}

/** Delay between successive API calls to avoid being flagged as abuse (ms). */
const REQUEST_DELAY_MS = 400

/**
 * Whether the definition's params suggest a reductive transform (output may be
 * shorter than input — append rather than in-place-replace). Detected from
 * param keys that indicate percentage/ratio condensation.
 */
function isReductive(def: TransformDefinition): boolean {
  return def.params.some((p) => p.key === 'percent' || p.key === 'ratio')
}

/**
 * Run a transform definition over the input paragraphs.
 *
 * Splits paragraphs into chunks that fit within the provider's {@link contextLimit}
 * (accounting for the system prompt and a safe output reserve). For reductive
 * transforms (percent/ratio params), each chunk's condensed paragraphs are
 * appended. Otherwise, transforms are count-preserving — paragraphs the model
 * under-delivers keep their original text.
 *
 * A 400 ms delay is inserted between chunks to avoid triggering provider rate
 * limits.
 */
export async function runTransform(
  input: string[],
  def: TransformDefinition,
  opParams: Record<string, string | number>,
  contextLimit: number,
  complete: CompleteFn,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  onDelta?: (textSoFar: string, delta: string) => void,
): Promise<string[]> {
  const systemPrompt = buildTransformMessages(def, opParams, []).system
  const systemTokens = estimateTokens(systemPrompt)
  const chunks = chunksForParagraphs(input, contextLimit, systemTokens)
  const reductive = isReductive(def)

  if (reductive) {
    const out: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as NonNullable<(typeof chunks)[0]>
      // Reset textSoFar at the start of each chunk — `onDelta` callers render
      // the current chunk's stream, not an accumulating cross-chunk blob.
      let chunkAcc = ''
      const raw = await complete(buildTransformMessages(def, opParams, chunk.paragraphs), {
        signal,
        onDelta: onDelta
          ? (_acc, delta) => {
              chunkAcc += delta
              onDelta(chunkAcc, delta)
            }
          : undefined,
      })
      out.push(...splitOutput(raw))
      onProgress?.(fraction(i + 1, chunks.length))
      if (i < chunks.length - 1) await delay(signal)
    }
    return out
  }

  const out = [...input]
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as NonNullable<(typeof chunks)[0]>
    let chunkAcc = ''
    const raw = await complete(buildTransformMessages(def, opParams, chunk.paragraphs), {
      signal,
      onDelta: onDelta
        ? (_acc, delta) => {
            chunkAcc += delta
            onDelta(chunkAcc, delta)
          }
        : undefined,
    })
    const parts = splitOutput(raw)
    const max = Math.min(parts.length, chunk.paragraphs.length)
    for (let j = 0; j < max; j++) {
      const idx = chunk.start + j
      if (idx < out.length) out[idx] = parts[j] ?? out[idx] ?? ''
    }
    onProgress?.(fraction(i + 1, chunks.length))
    if (i < chunks.length - 1) await delay(signal)
  }
  return out
}

/** Run AI-based outline detection over a flat paragraph list. */
export async function runOutlineDetection(
  paragraphs: string[],
  complete: CompleteFn,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<AiOutlineChapter[]> {
  const raw = await complete(buildOutlineMessages(paragraphs), { json: true, signal })
  onProgress?.(1)
  return parseOutlineCandidates(raw)
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

/**
 * Reconstruct the ordered {@link TransformOp} list from a book's
 * {@link AppliedProcessing} record. In the v2 schema this is simply `p.ops`;
 * legacy v1 records (`transforms: TransformKind[]`) have no current
 * definitions to map to (built-ins were removed in M6.2) and return an empty
 * list — the user's paragraphs are preserved in the chapters store regardless.
 */
export function opsFromProcessing(p: AppliedProcessing): TransformOp[] {
  return p.ops ?? []
}

async function delay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, REQUEST_DELAY_MS)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}
