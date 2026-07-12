import type { TransformOp } from './types'

/**
 * Per-op paragraph chunking. Each strategy produces {@link Chunk}s that carry
 * their source index range so callers can reassemble results back into the
 * book's `paragraphs`.
 *
 * - {@link solo}: one paragraph per chunk (cleanup — parallelizable, no context).
 * - {@link windowed}: sliding windows of `size` paragraphs with `overlap`
 *   (translate/summarize/simplify — needs surrounding context).
 * - {@link sample}: the first `maxParagraphs` as a single chunk
 *   (pronunciation-hints — scan the opening of the book).
 *
 * Chunking is by *paragraph count*, never by character, so surrogate pairs and
 * grapheme clusters inside a paragraph are always preserved intact.
 */

/** A contiguous slice of the input paragraphs, with its source range. */
export interface Chunk {
  /** Inclusive start index into the original input. */
  start: number
  /** Exclusive end index into the original input. */
  end: number
  paragraphs: string[]
}

/** One paragraph per chunk (cleanup). */
export function solo(input: string[]): Chunk[] {
  return input.map((paragraph, i) => ({
    start: i,
    end: i + 1,
    paragraphs: [paragraph],
  }))
}

/**
 * Sliding windows of `size` paragraphs, advancing by `size - overlap` each step.
 * An overlap paragraph therefore appears in two consecutive windows; reassembly
 * policy (which window "wins" the overlap) is the caller's concern.
 *
 * @throws RangeError if `size <= 0` or `overlap` is not in `[0, size)`.
 */
export function windowed(input: string[], size = 10, overlap = 1): Chunk[] {
  if (size <= 0) throw new RangeError('windowed: size must be > 0')
  if (overlap < 0 || overlap >= size) {
    throw new RangeError('windowed: overlap must be in [0, size)')
  }
  const chunks: Chunk[] = []
  const step = size - overlap
  for (let start = 0; start < input.length; start += step) {
    const end = Math.min(start + size, input.length)
    chunks.push({ start, end, paragraphs: input.slice(start, end) })
    if (end >= input.length) break
  }
  return chunks
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

/**
 * Pick the chunking strategy for a {@link TransformOp} (PRD §Decisions "Chunking"):
 * - `cleanup` → {@link solo} (one paragraph per chunk; parallelizable, no context).
 * - `translate` / `simplify` → {@link windowed} `(10, overlap=1)` (needs context;
 *   reassembly is last-write-wins on the overlap).
 * - `summarize` → {@link windowed} `(10, overlap=0)` (disjoint). Deviation from the
 *   PRD's "1-overlap for all windowed": overlapping windows would summarize the
 *   boundary paragraph twice, duplicating it in the condensed output. Disjoint
 *   windows concatenate cleanly. See `tasks/plan.md` deviations.
 */
export function chunksForOp(op: TransformOp, input: string[]): Chunk[] {
  switch (op.kind) {
    case 'cleanup':
      return solo(input)
    case 'translate':
    case 'simplify':
      return windowed(input, 10, 1)
    case 'summarize':
      return windowed(input, 10, 0)
  }
}
