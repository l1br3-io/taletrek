/**
 * Runtime token-aware paragraph chunking. Splits paragraphs into chunks that
 * fit within a provider's context window, using a character/4 token heuristic.
 * Chunk boundaries are always at paragraph breaks — a paragraph is never split
 * mid-text.
 */

/** A contiguous slice of the input paragraphs, with its source range. */
export interface Chunk {
  /** Inclusive start index into the original input. */
  start: number
  /** Exclusive end index into the original input. */
  end: number
  paragraphs: string[]
}

/**
 * The first `maxParagraphs` paragraphs as a single chunk (pronunciation-hints).
 * Caps at the input length. Returns an empty chunk for empty input.
 *
 * @throws RangeError if `maxParagraphs < 0`.
 */
export function sample(input: string[], maxParagraphs = 50): Chunk {
  if (maxParagraphs < 0) throw new RangeError('sample: maxParagraphs must be >= 0')
  const end = Math.min(maxParagraphs, input.length)
  return { start: 0, end, paragraphs: input.slice(0, end) }
}

/** Token reserve left for the model's response (avoids exceeding the context limit). */
const OUTPUT_RESERVE = 1024
const TOKENS_PER_CHAR = 0.25

/** Rough token count for a string using the char/4 heuristic. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length * TOKENS_PER_CHAR))
}

/**
 * Split paragraphs into chunks that each fit within `contextLimit` tokens
 * (after accounting for the system prompt and a safe output reserve). Every
 * chunk starts and ends at a paragraph boundary. A single paragraph that
 * exceeds the budget alone goes into its own chunk (the model may truncate).
 */
export function chunksForParagraphs(
  paragraphs: string[],
  contextLimit: number,
  systemPromptTokens: number,
): Chunk[] {
  const budget = Math.max(512, contextLimit - systemPromptTokens - OUTPUT_RESERVE)
  const chunks: Chunk[] = []
  let current: string[] = []
  let currentTokens = 0
  let startIdx = 0

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i] as string
    const paraTokens = estimateTokens(para)

    if (current.length > 0 && currentTokens + paraTokens > budget) {
      chunks.push({ start: startIdx, end: i, paragraphs: current })
      current = [para]
      currentTokens = paraTokens
      startIdx = i
    } else {
      current.push(para)
      currentTokens += paraTokens
    }
  }

  if (current.length > 0) {
    chunks.push({ start: startIdx, end: paragraphs.length, paragraphs: current })
  }

  return chunks
}
