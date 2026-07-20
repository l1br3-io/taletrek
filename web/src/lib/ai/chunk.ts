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

/**
 * UX-driven cap on per-chunk input size. Even when the model's context
 * window could fit more, we keep chunks small enough that prefill latency
 * stays tolerable. Without this cap, a 128K-context model receiving a
 * 12K-token chapter produces ONE chunk, and the user waits the model's
 * full prefill time (glm-4.7 on z.ai free tier measured 268s on
 * 2026-07-20) before any token streams. With the cap, the chapter splits
 * into multiple smaller chunks; each chunk's prefill is faster, and the
 * first chunk streams within seconds.
 *
 * Trade-off: smaller chunks = more LLM calls (slightly more cost on paid
 * tiers, no cost on free) but dramatically better UX. 2000 tokens ≈
 * 8KB of text ≈ 30 typical fiction paragraphs — enough for the model
 * to see local style/tone while keeping prefill under ~30s on most
 * models. If a reductive op (summarize) quality regresses, promote
 * this to a `TransformDefinition.chunkBudgetTokens` field so op types
 * can opt into a larger budget.
 */
const UX_MAX_CHUNK_TOKENS = 2000

/** Exposed for tests/asserts so callers can verify the UX cap is in effect. */
export const CHUNK_UX_CAP_TOKENS = UX_MAX_CHUNK_TOKENS

/** Rough token count for a string using the char/4 heuristic. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length * TOKENS_PER_CHAR))
}

/**
 * Split paragraphs into chunks that each fit within `contextLimit` tokens
 * (after accounting for the system prompt and a safe output reserve). Every
 * chunk starts and ends at a paragraph boundary. A single paragraph that
 * exceeds the budget alone goes into its own chunk (the model may truncate).
 *
 * Per-chunk size is `min(contextBudget, UX_MAX_CHUNK_TOKENS)` — the UX cap
 * keeps prefill latency tolerable regardless of the model's context window.
 */
export function chunksForParagraphs(
  paragraphs: string[],
  contextLimit: number,
  systemPromptTokens: number,
): Chunk[] {
  const contextBudget = contextLimit - systemPromptTokens - OUTPUT_RESERVE
  const budget = Math.max(512, Math.min(contextBudget, UX_MAX_CHUNK_TOKENS))
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
