import { describe, expect, it, vi } from 'vitest'
import { type CompleteFn, opsFromProcessing, runHints, runTransform } from './runner'
import type { AppliedProcessing } from './types'

/** Uppercases the joined user content and re-splits on blank lines (count-preserving round-trip). */
const upperComplete: CompleteFn = async (messages) => messages.user.toUpperCase()

describe('runTransform — cleanup (solo)', () => {
  it('one completion per paragraph, preserves count + order', async () => {
    const complete = vi.fn(upperComplete)
    const out = await runTransform(['a', 'b', 'c'], { kind: 'cleanup' }, complete)
    expect(out).toEqual(['A', 'B', 'C'])
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('reports increasing progress ending at 1', async () => {
    const fractions: number[] = []
    await runTransform(['a', 'b', 'c'], { kind: 'cleanup' }, upperComplete, (f) =>
      fractions.push(f),
    )
    expect(fractions).toEqual([1 / 3, 2 / 3, 1])
  })

  it('returns [] for empty input and reports progress 1', async () => {
    const complete = vi.fn(upperComplete)
    const fractions: number[] = []
    const out = await runTransform([], { kind: 'cleanup' }, complete, (f) => fractions.push(f))
    expect(out).toEqual([])
    expect(complete).not.toHaveBeenCalled()
    expect(fractions).toEqual([])
  })
})

describe('runTransform — fallback', () => {
  it('keeps the original paragraph when a completion returns empty', async () => {
    const complete = vi.fn(async (m) => (m.user === 'keep' ? 'CLEANED' : ''))
    const out = await runTransform(['keep', 'drop'], { kind: 'cleanup' }, complete)
    expect(out).toEqual(['CLEANED', 'drop'])
  })
})

describe('runTransform — translate (windowed, overlap=1, last-write-wins)', () => {
  it('preserves count across overlapping windows', async () => {
    const complete = vi.fn(upperComplete)
    const input = Array.from({ length: 11 }, (_, i) => `p${i}`)
    const out = await runTransform(input, { kind: 'translate', target: 'es' }, complete)
    // windowed(11, 10, 1) → [0,10), [9,11) → 2 completions, 11 outputs
    expect(out).toEqual(input.map((p) => p.toUpperCase()))
    expect(out).toHaveLength(11)
    expect(complete).toHaveBeenCalledTimes(2)
  })
})

describe('runTransform — summarize (disjoint, overlap=0)', () => {
  it('appends one condensed chunk per window', async () => {
    const complete = vi.fn(async () => 'SUM-A\n\nSUM-B')
    const input = Array.from({ length: 25 }, (_, i) => `p${i}`)
    const out = await runTransform(input, { kind: 'summarize', ratio: 0.5 }, complete)
    // windowed(25, 10, 0) → 3 windows; each yields 2 paragraphs → 6 appended
    expect(complete).toHaveBeenCalledTimes(3)
    expect(out).toEqual(['SUM-A', 'SUM-B', 'SUM-A', 'SUM-B', 'SUM-A', 'SUM-B'])
  })
})

describe('runTransform — abort', () => {
  it('forwards the AbortSignal to complete', async () => {
    const ac = new AbortController()
    const complete = vi.fn(async () => 'x')
    await runTransform(['a'], { kind: 'cleanup' }, complete, undefined, ac.signal)
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: ac.signal }),
    )
  })

  it('propagates an AbortError from complete', async () => {
    const ac = new AbortController()
    ac.abort()
    const complete = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(
      runTransform(['a'], { kind: 'cleanup' }, complete, undefined, ac.signal),
    ).rejects.toThrow()
  })
})

describe('runHints', () => {
  it('requests JSON mode and parses candidates', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({
        candidates: [
          { find: 'Siobhan', replace: 'shi-vawn', confidence: 0.9, category: 'proper-noun' },
        ],
      }),
    )
    const out = await runHints(['She met Siobhan.'], complete)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ find: 'Siobhan', confidence: 0.9 })
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ json: true }),
    )
  })

  it('reports progress 1 on completion', async () => {
    const fractions: number[] = []
    await runHints(
      ['x'],
      async () => '{"candidates":[]}',
      (f) => fractions.push(f),
    )
    expect(fractions).toEqual([1])
  })

  it('samples only the opening of the input', async () => {
    const complete = vi.fn(async (m) => m.user)
    const big = Array.from({ length: 200 }, (_, i) => `p${i}`)
    await runHints(big, complete)
    // default sample maxParagraphs=50 → user content is the first 50 joined
    const firstCall = complete.mock.calls[0]?.[0] as { user: string } | undefined
    expect((firstCall?.user ?? '').split('\n\n')).toHaveLength(50)
  })
})

describe('opsFromProcessing', () => {
  it('reconstructs the ordered ops from a full processing record', () => {
    const p: AppliedProcessing = {
      appliedAt: 1,
      transforms: ['cleanup', 'translate', 'summarize', 'simplify'],
      params: { translate: { target: 'fr' }, summarize: { ratio: 0.4 }, simplify: { level: 3 } },
    }
    expect(opsFromProcessing(p)).toEqual([
      { kind: 'cleanup' },
      { kind: 'translate', target: 'fr' },
      { kind: 'summarize', ratio: 0.4 },
      { kind: 'simplify', level: 3 },
    ])
  })

  it('falls back to defaults when params are missing', () => {
    const p: AppliedProcessing = {
      appliedAt: 1,
      transforms: ['translate', 'summarize', 'simplify'],
      params: {},
    }
    expect(opsFromProcessing(p)).toEqual([
      { kind: 'translate', target: 'es' },
      { kind: 'summarize', ratio: 0.5 },
      { kind: 'simplify', level: 2 },
    ])
  })

  it('returns [] for an empty transforms list', () => {
    const p: AppliedProcessing = { appliedAt: 1, transforms: [], params: {} }
    expect(opsFromProcessing(p)).toEqual([])
  })
})
