import { describe, expect, it } from 'vitest'
import { type Chunk, chunksForOp, sample, solo, windowed } from './chunk'

function paragraphs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `para-${i}`)
}

function flatten(chunks: Chunk[]): string[] {
  return chunks.flatMap((c) => c.paragraphs)
}

describe('solo', () => {
  it('produces one chunk per paragraph with contiguous ranges', () => {
    const input = paragraphs(3)
    const chunks = solo(input)
    expect(chunks).toEqual([
      { start: 0, end: 1, paragraphs: ['para-0'] },
      { start: 1, end: 2, paragraphs: ['para-1'] },
      { start: 2, end: 3, paragraphs: ['para-2'] },
    ])
  })

  it('returns no chunks for empty input', () => {
    expect(solo([])).toEqual([])
  })

  it('preserves a paragraph containing surrogate pairs intact', () => {
    const emoji = 'Thranduil wielded 🗡️ across the Eärendil 🌟 — Aiya!'
    const chunks = solo([emoji])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.paragraphs[0]).toBe(emoji)
  })
})

describe('windowed', () => {
  it('steps by size - overlap, capping the final window at input length', () => {
    const input = paragraphs(25)
    const chunks = windowed(input, 10, 1)
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 10],
      [9, 19],
      [18, 25],
    ])
  })

  it('with overlap 0 produces disjoint windows covering the input in order', () => {
    const input = paragraphs(25)
    const chunks = windowed(input, 10, 0)
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 10],
      [10, 20],
      [20, 25],
    ])
    // No paragraph duplicated; flattening reproduces the input.
    expect(flatten(chunks)).toEqual(input)
  })

  it('emits a single window when the input is smaller than size', () => {
    const input = paragraphs(4)
    const chunks = windowed(input, 10, 1)
    expect(chunks).toEqual([{ start: 0, end: 4, paragraphs: input }])
  })

  it('returns no chunks for empty input', () => {
    expect(windowed([], 10, 1)).toEqual([])
  })

  it('shares the overlap paragraph between consecutive windows', () => {
    const input = paragraphs(5)
    const chunks = windowed(input, 3, 1) // step 2: [0,3) [2,5)
    expect(chunks.map((c) => c.paragraphs)).toEqual([
      ['para-0', 'para-1', 'para-2'],
      ['para-2', 'para-3', 'para-4'],
    ])
  })

  it('preserves surrogate-pair paragraphs across the window boundary', () => {
    const input = ['before 🌟', 'overlap 🗡️', 'after ✨']
    const chunks = windowed(input, 2, 1)
    expect(chunks[1]?.paragraphs).toEqual(['overlap 🗡️', 'after ✨'])
  })

  it('uses defaults size=10 overlap=1', () => {
    const input = paragraphs(21)
    const chunks = windowed(input)
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 10],
      [9, 19],
      [18, 21],
    ])
  })

  it('throws RangeError for size <= 0', () => {
    expect(() => windowed(paragraphs(3), 0, 0)).toThrow(RangeError)
    expect(() => windowed(paragraphs(3), -1, 0)).toThrow(RangeError)
  })

  it('throws RangeError when overlap is out of range', () => {
    expect(() => windowed(paragraphs(10), 5, 5)).toThrow(RangeError)
    expect(() => windowed(paragraphs(10), 5, -1)).toThrow(RangeError)
  })
})

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

describe('chunksForOp', () => {
  it('cleanup uses solo (one paragraph per chunk)', () => {
    const chunks = chunksForOp({ kind: 'cleanup' }, paragraphs(3))
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
  })

  it('translate + simplify use windowed(10, overlap=1)', () => {
    const input = paragraphs(25)
    const ranges = (op: Parameters<typeof chunksForOp>[0]) =>
      chunksForOp(op, input).map((c) => [c.start, c.end])
    const expected = [
      [0, 10],
      [9, 19],
      [18, 25],
    ]
    expect(ranges({ kind: 'translate', target: 'es' })).toEqual(expected)
    expect(ranges({ kind: 'simplify', level: 2 })).toEqual(expected)
  })

  it('summarize uses windowed(10, overlap=0) — disjoint', () => {
    const chunks = chunksForOp({ kind: 'summarize', ratio: 0.5 }, paragraphs(25))
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 10],
      [10, 20],
      [20, 25],
    ])
  })

  it('returns no chunks for empty input across all ops', () => {
    expect(chunksForOp({ kind: 'cleanup' }, [])).toEqual([])
    expect(chunksForOp({ kind: 'translate', target: 'es' }, [])).toEqual([])
    expect(chunksForOp({ kind: 'summarize', ratio: 0.5 }, [])).toEqual([])
    expect(chunksForOp({ kind: 'simplify', level: 1 }, [])).toEqual([])
  })
})
