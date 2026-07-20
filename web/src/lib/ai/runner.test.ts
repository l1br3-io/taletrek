import { describe, expect, it, vi } from 'vitest'
import { type CompleteFn, opsFromProcessing, runHints, runTransform } from './runner'
import { type AppliedProcessing, type TransformDefinition, transformDefId } from './types'

function makeDef(overrides: Partial<TransformDefinition> = {}): TransformDefinition {
  return {
    id: transformDefId('t'),
    label: 'Test',
    hint: '',
    desc: '',
    systemPrompt: 'Fix.',
    params: [],
    ...overrides,
  }
}

const CTX = 32768

const cleanupDef = makeDef()
const translateDef = makeDef({
  id: transformDefId('translate'),
  systemPrompt: 'Translate to {{lang}}.',
  params: [{ key: 'lang', type: 'text', label: 'Target', default: 'es' }],
})
const summarizeDef = makeDef({
  id: transformDefId('summarize'),
  systemPrompt: 'Summarise at {{ratio}} ratio.',
  params: [{ key: 'ratio', type: 'range', label: 'Ratio', default: 0.5 }],
})

/** Uppercases the joined user content and re-splits on blank lines (count-preserving round-trip). */
const upperComplete: CompleteFn = async (messages) => messages.user.toUpperCase()

describe('runTransform — cleanup', () => {
  it('one completion per chunk, preserves count + order', async () => {
    const complete = vi.fn(upperComplete)
    const out = await runTransform(['a', 'b', 'c'], cleanupDef, {}, CTX, complete)
    expect(out).toEqual(['A', 'B', 'C'])
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('reports increasing progress ending at 1', async () => {
    const fractions: number[] = []
    await runTransform(['a', 'b', 'c'], cleanupDef, {}, CTX, upperComplete, (f) =>
      fractions.push(f),
    )
    expect(fractions).toEqual([1])
  })

  it('returns [] for empty input and reports no progress', async () => {
    const complete = vi.fn(upperComplete)
    const fractions: number[] = []
    const out = await runTransform([], cleanupDef, {}, CTX, complete, (f) => fractions.push(f))
    expect(out).toEqual([])
    expect(complete).not.toHaveBeenCalled()
    expect(fractions).toEqual([])
  })
})

describe('runTransform — fallback', () => {
  it('keeps the original paragraph when a completion returns empty', async () => {
    // Both paragraphs fit in one chunk. Completion returns only one part —
    // the second paragraph falls back to original.
    const complete = vi.fn(async () => 'CLEANED\n\n')
    const out = await runTransform(['keep', 'drop'], cleanupDef, {}, CTX, complete)
    expect(out).toEqual(['CLEANED', 'drop'])
  })

  it("clamps to chunk size — model over-return can't clobber a sibling's fallback", async () => {
    // Both paragraphs fit in one chunk. Model returns only one part;
    // the second paragraph keeps its original text.
    const complete = vi.fn(async () => 'X\n\n')
    const out = await runTransform(['a', 'b'], cleanupDef, {}, CTX, complete)
    expect(out).toEqual(['X', 'b'])
  })
})

describe('runTransform — translate (last-write-wins)', () => {
  it('preserves count when all paragraphs fit in one chunk', async () => {
    const complete = vi.fn(upperComplete)
    const input = Array.from({ length: 11 }, (_, i) => `p${i}`)
    const out = await runTransform(input, translateDef, { lang: 'es' }, CTX, complete)
    expect(out).toEqual(input.map((p) => p.toUpperCase()))
    expect(out).toHaveLength(11)
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

describe('runTransform — summarize (reductive)', () => {
  it('appends one condensed chunk per window', async () => {
    const complete = vi.fn(async () => 'SUM-A\n\nSUM-B')
    const input = Array.from({ length: 25 }, (_, i) => `p${i}`)
    const out = await runTransform(input, summarizeDef, { ratio: 0.5 }, CTX, complete)
    // contextLimit=32768, budget ~31644 → all 25 short paragraphs fit in 1 chunk
    expect(complete).toHaveBeenCalledTimes(1)
    expect(out).toEqual(['SUM-A', 'SUM-B'])
  })
})

describe('runTransform — abort', () => {
  it('forwards the AbortSignal to complete', async () => {
    const ac = new AbortController()
    const complete = vi.fn(async () => 'x')
    await runTransform(['a'], cleanupDef, {}, CTX, complete, undefined, ac.signal)
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
      runTransform(['a'], cleanupDef, {}, CTX, complete, undefined, ac.signal),
    ).rejects.toThrow()
  })
})

describe('runTransform — streaming (onDelta)', () => {
  it('forwards onDelta to complete and accumulates within a chunk', async () => {
    // Single chunk (short input). complete emits three deltas; runTransform
    // should re-buffer so onDelta callers see chunk-local textSoFar.
    const complete = vi.fn(async (_msgs, opts) => {
      opts?.onDelta?.('A', 'A')
      opts?.onDelta?.('AB', 'B')
      opts?.onDelta?.('ABC', 'C')
      return 'ABC'
    })
    const seen: Array<{ soFar: string; delta: string }> = []
    await runTransform(
      ['p0'],
      cleanupDef,
      {},
      CTX,
      complete,
      undefined,
      undefined,
      (soFar, delta) => seen.push({ soFar, delta }),
    )
    expect(seen).toEqual([
      { soFar: 'A', delta: 'A' },
      { soFar: 'AB', delta: 'B' },
      { soFar: 'ABC', delta: 'C' },
    ])
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('resets textSoFar between chunks (does not accumulate cross-chunk)', async () => {
    // Force two chunks: CTX=2048 → budget = max(512, 2048-1-1024) = 1023 tokens.
    // 2200 chars * 0.25 = 550 tokens per paragraph → first fits (550<1023),
    // first+second doesn't (1100>1023) → one paragraph per chunk.
    const bigA = 'a'.repeat(2200)
    const bigB = 'b'.repeat(2200)
    const complete = vi.fn(async (_msgs, opts) => {
      opts?.onDelta?.('X', 'X')
      opts?.onDelta?.('XY', 'Y')
      return 'XY'
    })
    const seen: string[] = []
    await runTransform(
      [bigA, bigB],
      cleanupDef,
      {},
      2048,
      complete,
      undefined,
      undefined,
      (soFar) => seen.push(soFar),
    )
    // Each chunk resets — second chunk's first delta is 'X', not 'XYX'.
    expect(complete).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(['X', 'XY', 'X', 'XY'])
  })

  it('does not invoke onDelta when not provided (no crash)', async () => {
    const complete = vi.fn(async () => 'x')
    const out = await runTransform(['a'], cleanupDef, {}, CTX, complete)
    expect(out).toEqual(['x'])
  })
})

describe('runTransform — chunk streaming (onChunkStreamed)', () => {
  it('fires onChunkStreamed on each token batch with isFinal=false', async () => {
    const complete = vi.fn(async (_msgs, opts) => {
      opts?.onDelta?.('A', 'A')
      opts?.onDelta?.('AB', 'B')
      return 'AB'
    })
    const events: Array<{ textSoFar: string; delta: string; isFinal: boolean }> = []
    await runTransform(
      ['p0'],
      cleanupDef,
      {},
      CTX,
      complete,
      undefined,
      undefined,
      undefined,
      (info) =>
        events.push({ textSoFar: info.textSoFar, delta: info.delta, isFinal: info.isFinal }),
    )
    // Two non-final fires (one per delta), then one final fire with empty delta.
    expect(events).toEqual([
      { textSoFar: 'A', delta: 'A', isFinal: false },
      { textSoFar: 'AB', delta: 'B', isFinal: false },
      { textSoFar: 'AB', delta: '', isFinal: true },
    ])
  })

  it('propagates reasoning tokens via reasoningSoFar (reasoning-model support)', async () => {
    // Reasoning models (glm-5.2, DeepSeek-R1) emit thinking tokens via a
    // separate callback BEFORE the visible content. The runner must thread
    // these through to onChunkStreamed.reasoningSoFar so the UI can surface
    // "model is thinking" feedback during the otherwise-opaque gap.
    const complete = vi.fn(async (_msgs, opts) => {
      opts?.onReasoning?.('Thinking A', 'Thinking A')
      opts?.onReasoning?.('Thinking AThinking B', 'Thinking B')
      opts?.onDelta?.('Hello', 'Hello') // Content starts AFTER reasoning
      return 'Hello'
    })
    const events: Array<{ textSoFar: string; reasoningSoFar: string }> = []
    await runTransform(
      ['p0'],
      cleanupDef,
      {},
      CTX,
      complete,
      undefined,
      undefined,
      undefined,
      (info) => events.push({ textSoFar: info.textSoFar, reasoningSoFar: info.reasoningSoFar }),
    )
    // First two fires: reasoning only, no content yet.
    expect(events[0]).toEqual({ textSoFar: '', reasoningSoFar: 'Thinking A' })
    expect(events[1]).toEqual({ textSoFar: '', reasoningSoFar: 'Thinking AThinking B' })
    // Third fire: content arrives, reasoning still carried along.
    expect(events[2]).toEqual({ textSoFar: 'Hello', reasoningSoFar: 'Thinking AThinking B' })
    // Final fire includes accumulated reasoning.
    expect(events[events.length - 1]?.reasoningSoFar).toBe('Thinking AThinking B')
  })

  it('includes chunkIndex, chunkTotal, chunkStartInputIndex in each fire', async () => {
    // Force two chunks (one paragraph each) by using a small context limit.
    const bigA = 'a'.repeat(2200)
    const bigB = 'b'.repeat(2200)
    const complete = vi.fn(async (_msgs, opts) => {
      opts?.onDelta?.('X', 'X')
      return 'X'
    })
    const events: Array<{ chunkIndex: number; chunkTotal: number; chunkStartInputIndex: number }> =
      []
    await runTransform(
      [bigA, bigB],
      cleanupDef,
      {},
      2048,
      complete,
      undefined,
      undefined,
      undefined,
      (info) =>
        events.push({
          chunkIndex: info.chunkIndex,
          chunkTotal: info.chunkTotal,
          chunkStartInputIndex: info.chunkStartInputIndex,
        }),
    )
    expect(events).toEqual([
      { chunkIndex: 0, chunkTotal: 2, chunkStartInputIndex: 0 },
      { chunkIndex: 0, chunkTotal: 2, chunkStartInputIndex: 0 },
      { chunkIndex: 1, chunkTotal: 2, chunkStartInputIndex: 1 },
      { chunkIndex: 1, chunkTotal: 2, chunkStartInputIndex: 1 },
    ])
  })

  it('attaches finalParagraphs on the isFinal=true fire (non-reductive)', async () => {
    const complete = vi.fn(async () => 'CLEAN-A\n\nCLEAN-B')
    const finals: Array<{ finalParagraphs?: string[]; isFinal: boolean }> = []
    await runTransform(
      ['a', 'b'],
      cleanupDef,
      {},
      CTX,
      complete,
      undefined,
      undefined,
      undefined,
      (info) => {
        if (info.isFinal) finals.push({ finalParagraphs: info.finalParagraphs, isFinal: true })
      },
    )
    expect(finals).toEqual([{ finalParagraphs: ['CLEAN-A', 'CLEAN-B'], isFinal: true }])
  })

  it('attaches finalParagraphs on the isFinal=true fire (reductive — summarize)', async () => {
    const complete = vi.fn(async () => 'SUM-A\n\nSUM-B')
    const finals: Array<{ finalParagraphs?: string[]; isFinal: boolean }> = []
    await runTransform(
      Array.from({ length: 5 }, (_, i) => `p${i}`),
      summarizeDef,
      { ratio: 0.5 },
      CTX,
      complete,
      undefined,
      undefined,
      undefined,
      (info) => {
        if (info.isFinal) finals.push({ finalParagraphs: info.finalParagraphs, isFinal: true })
      },
    )
    expect(finals).toEqual([{ finalParagraphs: ['SUM-A', 'SUM-B'], isFinal: true }])
  })

  it('resets textSoFar at each chunk boundary', async () => {
    const bigA = 'a'.repeat(2200)
    const bigB = 'b'.repeat(2200)
    const complete = vi.fn(async (_msgs, opts) => {
      opts?.onDelta?.('X', 'X')
      opts?.onDelta?.('XY', 'Y')
      return 'XY'
    })
    const firstDeltas: string[] = []
    await runTransform(
      [bigA, bigB],
      cleanupDef,
      {},
      2048,
      complete,
      undefined,
      undefined,
      undefined,
      (info) => {
        if (!info.isFinal && info.delta) firstDeltas.push(info.textSoFar)
      },
    )
    // First fire of each chunk should be 'X', not accumulating across chunks.
    expect(firstDeltas).toEqual(['X', 'XY', 'X', 'XY'])
  })

  it('does not fire when onChunkStreamed is not provided (no crash)', async () => {
    const complete = vi.fn(async () => 'x')
    const out = await runTransform(['a'], cleanupDef, {}, CTX, complete)
    expect(out).toEqual(['x'])
  })

  it('fires onChunkStreamed even when onDelta is not provided', async () => {
    // Engine should still wire onDelta internally to feed onChunkStreamed.
    const complete = vi.fn(async (_msgs, opts) => {
      opts?.onDelta?.('A', 'A')
      return 'A'
    })
    const events: string[] = []
    await runTransform(
      ['p0'],
      cleanupDef,
      {},
      CTX,
      complete,
      undefined,
      undefined,
      undefined,
      (info) => events.push(info.textSoFar),
    )
    expect(events).toEqual(['A', 'A']) // one non-final, one final
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
  it('returns the ops array from a processing record', () => {
    const p: AppliedProcessing = {
      appliedAt: 1,
      ops: [
        { defId: transformDefId('t'), params: {} },
        { defId: transformDefId('translate'), params: { lang: 'fr' } },
        { defId: transformDefId('summarize'), params: { ratio: 0.4 } },
        { defId: transformDefId('simplify'), params: { level: 3 } },
      ],
    }
    expect(opsFromProcessing(p)).toEqual([
      { defId: transformDefId('t'), params: {} },
      { defId: transformDefId('translate'), params: { lang: 'fr' } },
      { defId: transformDefId('summarize'), params: { ratio: 0.4 } },
      { defId: transformDefId('simplify'), params: { level: 3 } },
    ])
  })

  it('returns [] for an empty ops list', () => {
    const p: AppliedProcessing = { appliedAt: 1, ops: [] }
    expect(opsFromProcessing(p)).toEqual([])
  })
})

describe('runTransform — empty-response guard', () => {
  // Some providers return 200 OK with an empty SSE body (quota hit, model
  // down, misconfigured reverse proxy). Without this guard, splitOutput('')
  // returns [] and the manager commits a chapter with zero paragraphs —
  // wiping the user's book. The guard throws so the manager surfaces a
  // clear error in the reader banner.
  it('throws when the provider returns empty output for non-empty input', async () => {
    const emptyComplete: CompleteFn = async () => ''
    await expect(runTransform(['hello world'], cleanupDef, {}, CTX, emptyComplete)).rejects.toThrow(
      /empty response/,
    )
  })

  it('throws when the provider returns only whitespace', async () => {
    const wsComplete: CompleteFn = async () => '   \n  \t  '
    await expect(runTransform(['hello world'], cleanupDef, {}, CTX, wsComplete)).rejects.toThrow(
      /empty response/,
    )
  })

  it('does NOT throw when input is also empty (legitimate cleanup pass)', async () => {
    const emptyComplete: CompleteFn = async () => ''
    // All-whitespace input is a normal outcome of upstream cleaning — should
    // not trigger the guard. Output preserves the whitespace input unchanged
    // (count-preserving fallback path).
    const result = await runTransform(['   '], cleanupDef, {}, CTX, emptyComplete)
    expect(result).toEqual(['   '])
  })

  it('throws on the reductive branch too (summarize)', async () => {
    const emptyComplete: CompleteFn = async () => ''
    await expect(
      runTransform(['hello world'], summarizeDef, { ratio: 0.5 }, CTX, emptyComplete),
    ).rejects.toThrow(/empty response/)
  })
})
