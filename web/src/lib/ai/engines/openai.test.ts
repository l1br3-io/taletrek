import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearApiKey, setApiKey } from '../keyring'
import { type TransformDefinition, transformDefId } from '../types'
import { CloudLlmEngine } from './openai'

const BASE = 'https://api.openai.com/v1'
const MODEL = 'gpt-4o-mini'
const PID = 'provider-1'
const CTX = 32768

const testDef: TransformDefinition = {
  id: transformDefId('t'),
  label: 'Test',
  hint: '',
  desc: '',
  systemPrompt: 'Fix.',
  params: [],
}

const summarizeDef: TransformDefinition = {
  id: transformDefId('s'),
  label: 'Summarise',
  hint: '',
  desc: '',
  systemPrompt: 'Summarise at {{ratio}} ratio.',
  params: [{ key: 'ratio', type: 'range', label: 'Ratio', default: 0.5 }],
}

function soloOp(): {
  defId: ReturnType<typeof transformDefId>
  params: Record<string, string | number>
} {
  return { defId: transformDefId('t'), params: {} }
}

function sseData(json: unknown): string {
  return `data: ${JSON.stringify(json)}\n\n`
}
const DONE = 'data: [DONE]\n\n'

function delta(content: string): string {
  return sseData({ choices: [{ index: 0, delta: { content } }] })
}

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p))
      controller.close()
    },
  })
}

function ok(parts: string[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: streamOf(parts),
    text: () => Promise.resolve(''),
  } as unknown as Response
}

function err(status: number, statusText: string, body: string): Response {
  return {
    ok: false,
    status,
    statusText,
    body: null,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

/** Read the i-th recorded fetch call defensively (noUncheckedIndexedAccess-safe). */
function callN(mock: unknown, i = 0): [string, RequestInit] {
  const calls = (mock as { mock?: { calls?: unknown[] } }).mock?.calls ?? []
  const c = calls.at(i) as [string, RequestInit] | undefined
  if (!c) throw new Error(`fetch was not called (expected call ${i})`)
  return c
}

function bodyN(mock: unknown, i = 0): Record<string, unknown> {
  return JSON.parse(callN(mock, i)[1].body as string) as Record<string, unknown>
}

beforeEach(() => {
  setApiKey(PID, 'sk-test')
})
afterEach(() => {
  clearApiKey(PID)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CloudLlmEngine.isReady', () => {
  it('reflects key presence + config', async () => {
    clearApiKey(PID)
    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    expect(await engine.isReady()).toBe(false)
    setApiKey(PID, 'sk-x')
    expect(await engine.isReady()).toBe(true)
  })

  it('is false without a baseUrl', async () => {
    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: '',
      model: MODEL,
      contextLimit: CTX,
    })
    expect(await engine.isReady()).toBe(false)
  })
})

describe('CloudLlmEngine.transform — cleanup', () => {
  it('issues one completion per chunk with correct request shape', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      ok([delta('CLEAN\n\nCLEAN'), DONE]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    const out = await engine.transform(['p-one', 'p-two'], soloOp(), testDef)

    // Both fit in one chunk; model returns two parts → both get CLEAN.
    expect(out).toEqual(['CLEAN', 'CLEAN'])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = callN(fetchMock)
    expect(url).toBe(`${BASE}/chat/completions`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Accept).toBe('text/event-stream')

    const body = bodyN(fetchMock)
    expect(body.model).toBe(MODEL)
    expect(body.stream).toBe(true)
    expect((body.stream_options as Record<string, unknown>).include_usage).toBe(true)
    const msgs = body.messages as Array<{ role: string; content: string }>
    expect(msgs[0]?.role).toBe('system')
    expect(msgs[1]?.role).toBe('user')
    // Both paragraphs fit in one chunk — sent joined.
    expect(msgs[1]?.content).toBe('p-one\n\np-two')
  })

  it('concatenates SSE deltas split across events', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      ok([delta('Hello'), delta(', '), delta('world!'), DONE]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    const out = await engine.transform(['x'], soloOp(), testDef)
    expect(out).toEqual(['Hello, world!'])
  })

  it('reports progress 1 for a single chunk', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ok([delta('c'), DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const fractions: number[] = []
    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    await engine.transform(['a', 'b', 'c'], soloOp(), testDef, (f) => fractions.push(f))
    expect(fractions).toEqual([1])
  })

  it('keeps the original paragraph when a completion returns empty for it', async () => {
    // Return only one part for two paragraphs — second falls back to original.
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      ok([delta('CLEANED\n\n'), DONE]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    const out = await engine.transform(['p-one', 'p-two'], soloOp(), testDef)
    expect(out).toEqual(['CLEANED', 'p-two'])
  })
})

describe('CloudLlmEngine.transform — summarize', () => {
  it('condenses input paragraphs into fewer output paragraphs', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ok([delta('SUM'), DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    const out = await engine.transform(
      Array.from({ length: 25 }, (_, i) => `p${i}`),
      { defId: transformDefId('s'), params: { ratio: 0.5 } },
      summarizeDef,
    )
    // All 25 short paragraphs fit within 1 chunk at contextLimit 32768 → 1 completion, 1 output.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.length).toBe(1)
  })
})

describe('CloudLlmEngine.transform — errors + abort', () => {
  it('throws CloudError on non-200 with status', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      err(429, 'Too Many Requests', 'rate limited'),
    )
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    await expect(engine.transform(['a'], soloOp(), testDef)).rejects.toMatchObject({
      name: 'CloudError',
      status: 429,
    })
  })

  it('throws CloudError(401) before any request when no key is set', async () => {
    clearApiKey(PID)
    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    await expect(engine.transform(['a'], soloOp(), testDef)).rejects.toMatchObject({
      name: 'CloudError',
      status: 401,
    })
  })

  it('forwards the AbortSignal to fetch and propagates abort', async () => {
    const ac = new AbortController()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return ok([delta('x'), DONE])
    })
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    ac.abort()
    await expect(engine.transform(['a'], soloOp(), testDef, undefined, ac.signal)).rejects.toThrow()
    expect(callN(fetchMock)[1].signal).toBe(ac.signal)
  })

  it('trims trailing slashes from baseUrl', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ok([delta('c'), DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: 'https://api.openai.com/v1///',
      model: MODEL,
      contextLimit: CTX,
    })
    await engine.transform(['a'], soloOp(), testDef)
    expect(callN(fetchMock)[0]).toBe('https://api.openai.com/v1/chat/completions')
  })
})

describe('CloudLlmEngine.proposePronunciationHints', () => {
  it('requests JSON mode and parses candidates', async () => {
    const payload = {
      candidates: [
        { find: 'Siobhan', replace: 'shi-vawn', confidence: 0.9, category: 'proper-noun' },
      ],
    }
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      ok([delta(JSON.stringify(payload)), DONE]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    const out = await engine.proposePronunciationHints(['She met Siobhan at the gate.'])

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      find: 'Siobhan',
      replace: 'shi-vawn',
      confidence: 0.9,
      category: 'proper-noun',
    })
    expect(bodyN(fetchMock).response_format).toEqual({ type: 'json_object' })
  })

  it('tolerates a bare array response', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      ok([delta(JSON.stringify([{ find: 'x', replace: 'y' }])), DONE]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    const out = await engine.proposePronunciationHints(['x y'])
    expect(out).toHaveLength(1)
  })

  it('returns [] on unparseable JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      ok([delta('not json at all'), DONE]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const engine = new CloudLlmEngine({
      providerId: PID,
      baseUrl: BASE,
      model: MODEL,
      contextLimit: CTX,
    })
    const out = await engine.proposePronunciationHints(['x'])
    expect(out).toEqual([])
  })
})
