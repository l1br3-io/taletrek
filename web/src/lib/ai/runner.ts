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
  ChunkStreamInfo,
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
    /** Per-reasoning-delta callback (reasoning models only). See {@link CompleteOptions.onReasoning}. */
    onReasoning?: (reasoningSoFar: string, delta: string) => void
  },
) => Promise<string>

/** Progress fraction, treating an empty chunk list as already complete. */
function fraction(done: number, total: number): number {
  return total === 0 ? 1 : done / total
}

/** Delay between successive API calls to avoid being flagged as abuse (ms). */
const REQUEST_DELAY_MS = 400

/**
 * Guard against silent provider failures that return 200 OK but empty bodies.
 * Without this, `splitOutput('')` returns `[]` and the manager commits a
 * chapter with zero paragraphs — wiping the user's book. Throw loudly so the
 * manager surfaces a clear error in the banner and the user can retry / pick
 * a different model. Only throws when the input was non-empty (otherwise the
 * guard would fire on legitimately-empty cleanup passes).
 */
function assertNonEmptyResponse(raw: string, inputParagraphs: string[]): void {
  if (raw.trim() === '' && inputParagraphs.some((p) => p.trim() !== '')) {
    throw new Error(
      'Provider returned an empty response — check your API key, quota, and model availability.',
    )
  }
}

/**
 * Whether the definition's params suggest a reductive transform (output may be
 * shorter than input — append rather than in-place-replace). Detected from
 * param keys that indicate percentage/ratio condensation.
 */
export function isReductive(def: TransformDefinition): boolean {
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
  onChunkStreamed?: (info: ChunkStreamInfo) => void,
): Promise<string[]> {
  const systemPrompt = buildTransformMessages(def, opParams, []).system
  const systemTokens = estimateTokens(systemPrompt)
  const chunks = chunksForParagraphs(input, contextLimit, systemTokens)
  const reductive = isReductive(def)

  if (reductive) {
    const out: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as NonNullable<(typeof chunks)[0]>
      // Reset textSoFar at the start of each chunk — `onDelta`/`onChunkStreamed`
      // callers render the current chunk's stream, not an accumulating cross-chunk blob.
      let chunkAcc = ''
      let reasoningAcc = ''
      // Shared fire routine — called whenever content OR reasoning updates,
      // so the consumer sees a consistent (textSoFar, reasoningSoFar) pair.
      const fire = (delta: string): void => {
        onChunkStreamed?.({
          chunkIndex: i,
          chunkTotal: chunks.length,
          chunkStartInputIndex: chunk.start,
          chunkInputCount: chunk.paragraphs.length,
          textSoFar: chunkAcc,
          reasoningSoFar: reasoningAcc,
          delta,
          isFinal: false,
        })
      }
      const raw = await complete(buildTransformMessages(def, opParams, chunk.paragraphs), {
        signal,
        onDelta:
          onDelta || onChunkStreamed
            ? (_acc, delta) => {
                chunkAcc += delta
                onDelta?.(chunkAcc, delta)
                fire(delta)
              }
            : undefined,
        onReasoning: onChunkStreamed
          ? (_acc, delta) => {
              reasoningAcc += delta
              fire(delta)
            }
          : undefined,
      })
      assertNonEmptyResponse(raw, chunk.paragraphs)
      const finalParagraphs = splitOutput(raw)
      out.push(...finalParagraphs)
      onChunkStreamed?.({
        chunkIndex: i,
        chunkTotal: chunks.length,
        chunkStartInputIndex: chunk.start,
        chunkInputCount: chunk.paragraphs.length,
        textSoFar: raw,
        reasoningSoFar: reasoningAcc,
        delta: '',
        isFinal: true,
        finalParagraphs,
      })
      onProgress?.(fraction(i + 1, chunks.length))
      if (i < chunks.length - 1) await delay(signal)
    }
    return out
  }

  const out = [...input]
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as NonNullable<(typeof chunks)[0]>
    let chunkAcc = ''
    let reasoningAcc = ''
    const fire = (delta: string): void => {
      onChunkStreamed?.({
        chunkIndex: i,
        chunkTotal: chunks.length,
        chunkStartInputIndex: chunk.start,
        chunkInputCount: chunk.paragraphs.length,
        textSoFar: chunkAcc,
        reasoningSoFar: reasoningAcc,
        delta,
        isFinal: false,
      })
    }
    const raw = await complete(buildTransformMessages(def, opParams, chunk.paragraphs), {
      signal,
      onDelta:
        onDelta || onChunkStreamed
          ? (_acc, delta) => {
              chunkAcc += delta
              onDelta?.(chunkAcc, delta)
              fire(delta)
            }
          : undefined,
      onReasoning: onChunkStreamed
        ? (_acc, delta) => {
            reasoningAcc += delta
            fire(delta)
          }
        : undefined,
    })
    assertNonEmptyResponse(raw, chunk.paragraphs)
    const parts = splitOutput(raw)
    const max = Math.min(parts.length, chunk.paragraphs.length)
    for (let j = 0; j < max; j++) {
      const idx = chunk.start + j
      if (idx < out.length) out[idx] = parts[j] ?? out[idx] ?? ''
    }
    onChunkStreamed?.({
      chunkIndex: i,
      chunkTotal: chunks.length,
      chunkStartInputIndex: chunk.start,
      chunkInputCount: chunk.paragraphs.length,
      textSoFar: raw,
      reasoningSoFar: reasoningAcc,
      delta: '',
      isFinal: true,
      finalParagraphs: parts,
    })
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
