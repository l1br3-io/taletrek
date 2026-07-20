import { describe, expect, it } from 'vitest'
import { CHUNK_UX_CAP_TOKENS, chunksForParagraphs, estimateTokens, sample } from './chunk'

function paragraphs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `para-${i}`)
}

describe('sample', () => {
  it('returns the first maxParagraphs as a single chunk', () => {
    const input = paragraphs(100)
    const chunk = sample(input, 10)
    expect(chunk).toEqual({ start: 0, end: 10, paragraphs: paragraphs(10) })
  })

  it('caps at the input length when input is shorter', () => {
    const input = paragraphs(3)
    const chunk = sample(input, 50)
    expect(chunk).toEqual({ start: 0, end: 3, paragraphs: input })
  })

  it('defaults to 50 paragraphs', () => {
    const input = paragraphs(80)
    expect(sample(input)).toEqual({ start: 0, end: 50, paragraphs: paragraphs(50) })
  })

  it('returns an empty chunk for empty input', () => {
    expect(sample([])).toEqual({ start: 0, end: 0, paragraphs: [] })
  })

  it('preserves surrogate pairs in the sampled text', () => {
    const input = ['🌟 start', '🗡️ middle', '✨ end']
    expect(sample(input, 2).paragraphs).toEqual(['🌟 start', '🗡️ middle'])
  })

  it('throws RangeError for negative maxParagraphs', () => {
    expect(() => sample(paragraphs(3), -1)).toThrow(RangeError)
  })
})

describe('estimateTokens', () => {
  it('returns max(1, ceil(len * 0.25))', () => {
    expect(estimateTokens('')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2) // 5 * 0.25 = 1.25 → ceil 2
    expect(estimateTokens('12345678')).toBe(2) // 8 * 0.25 = 2
  })
})

describe('chunksForParagraphs', () => {
  // budget = max(512, contextLimit - systemPromptTokens - 1024)

  it('returns no chunks for empty input', () => {
    expect(chunksForParagraphs([], 32768, 100)).toEqual([])
  })

  it('splits paragraphs into chunks respecting the token budget', () => {
    // contextLimit=32768, systemPromptTokens=100 → budget=31644
    // Each "a" is 1 char → estimateTokens="max(1,ceil(0.25))"=1 token
    // budget=31644 tokens, so we can fit up to 31644 paragraphs per chunk
    // Use 10-paragraph chunks for readability: make each paragraph ~3164 chars
    // Simpler: use a tight budget to force chunk splitting
    //
    // contextLimit=2096, systemPromptTokens=100 → budget = 2096-100-1024 = 972
    // Each para is 4000 chars → 4000*0.25=1000 tokens. budget=972 < 1000,
    // so each paragraph gets its own chunk.
    const bigPara = 'x'.repeat(4000) // ~1000 tokens each
    const input = [bigPara, bigPara, bigPara]
    const chunks = chunksForParagraphs(input, 2096, 100)
    expect(chunks).toHaveLength(3)
    chunks.forEach((c, i) => {
      expect(c.start).toBe(i)
      expect(c.end).toBe(i + 1)
      expect(c.paragraphs).toEqual([bigPara])
    })
  })

  it('never cuts mid-paragraph — a paragraph always stays in one chunk', () => {
    // Same tight budget as above. Each 4000-char para is ~1000 tokens, which
    // exceeds the 972-token budget alone, but the implementation still puts
    // it in its own chunk rather than splitting the text.
    const para = 'ABCDEFGH'.repeat(500) // 4000 chars → ~1000 tokens
    const chunks = chunksForParagraphs([para], 2096, 100)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.paragraphs).toEqual([para])
  })

  it('groups paragraphs that fit under budget into a single chunk', () => {
    // contextLimit=32768, systemPromptTokens=0 → budget=32768-0-1024=31744
    // Each "para-N" is 6 chars → 2 tokens. 100 paragraphs → 200 tokens.
    // Well under budget: should be 1 chunk.
    const input = paragraphs(100)
    const chunks = chunksForParagraphs(input, 32768, 0)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.start).toBe(0)
    expect(chunks[0]?.end).toBe(100)
    expect(chunks[0]?.paragraphs).toEqual(input)
  })

  it('covers the input exactly with contiguous ranges', () => {
    // Tight budget forces one paragraph per chunk.
    const bigPara = 'x'.repeat(4000)
    const input = [bigPara, bigPara, bigPara]
    const chunks = chunksForParagraphs(input, 2096, 100)
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
  })

  it('preserves surrogate-pair paragraphs intact', () => {
    const emoji = 'Thranduil wielded 🗡️ across the Eärendil 🌟 — Aiya!'
    const chunks = chunksForParagraphs([emoji], 32768, 0)
    expect(chunks[0]?.paragraphs[0]).toBe(emoji)
  })

  it('uses a minimum budget of 512 tokens', () => {
    // contextLimit and systemPromptTokens so large that budget would be ≤0,
    // but floors at 512.
    const para = 'hello' // 5 chars → 2 tokens
    const chunks = chunksForParagraphs([para, para, para], 200, 90)
    // budget = max(512, 200-90-1024) = 512. Each para is 2 tokens, so all 3
    // easily fit in one chunk.
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.paragraphs).toEqual([para, para, para])
  })

  it('applies the UX chunk-size cap regardless of contextLimit (large-context regression guard)', () => {
    // Regression guard for the 2026-07-20 finding: glm-4.7 with 128K context
    // received a 12K-token chapter as ONE chunk, and the user waited 268s
    // for the model's prefill before any token streamed. The UX cap splits
    // the chapter into multiple smaller chunks so each chunk's prefill is
    // tolerable (target: under ~30s on typical models).
    //
    // Setup: 200 paragraphs × ~50 tokens each = 10,000 tokens total.
    //   - Without UX cap: budget = 128K - 100 - 1024 = ~127K → 1 chunk.
    //   - With UX cap of 2000: budget = min(127K, 2000) = 2000 → 5 chunks
    //     (40 paras × 50 tokens = 2000 each).
    const para50Tokens = 'x'.repeat(200) // 200 chars × 0.25 = 50 tokens
    const input = Array.from({ length: 200 }, () => para50Tokens)
    const chunks = chunksForParagraphs(input, 128_000, 100)
    expect(chunks.length).toBeGreaterThan(1)
    // Each chunk's token count must stay under the UX cap.
    for (const c of chunks) {
      const tokens = c.paragraphs.reduce((sum, p) => sum + estimateTokens(p), 0)
      // Allow the cap + one paragraph overflow (chunk boundary is at
      // paragraph granularity, so a chunk can be slightly over if the last
      // paragraph pushed it past). Verify the bound is the UX cap, not the
      // contextLimit.
      expect(tokens).toBeLessThanOrEqual(CHUNK_UX_CAP_TOKENS + estimateTokens(para50Tokens))
    }
  })

  it('does not apply the UX cap when contextLimit is smaller than the cap', () => {
    // For very small context models (e.g. older 4K-context Llama variants),
    // the context budget is the binding constraint, not the UX cap.
    // budget = min(contextBudget, UX_MAX) = min(972, 2000) = 972.
    const bigPara = 'x'.repeat(4000) // ~1000 tokens each
    const input = [bigPara, bigPara, bigPara]
    const chunks = chunksForParagraphs(input, 2096, 100)
    expect(chunks).toHaveLength(3)
  })
})
