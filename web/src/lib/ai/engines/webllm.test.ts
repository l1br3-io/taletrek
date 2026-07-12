import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@mlc-ai/web-llm', () => ({
  CreateWebWorkerMLCEngine: vi.fn(),
  prebuiltAppConfig: { model_list: [] },
}))
vi.mock('../webgpu', () => ({ hasWebGpu: vi.fn() }))

import type { MLCEngineInterface, WebWorkerMLCEngine } from '@mlc-ai/web-llm'
import { CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm'
import { hasWebGpu } from '../webgpu'
import { WebLlmEngine, WebLlmError } from './webllm'

const MODEL = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'

class WorkerStub {
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
}

/** Build a fake resident engine proxy with a streaming create(). */
function fakeEngine(
  chunks: string[] = ['OUT'],
  overrides: Partial<MLCEngineInterface> = {},
): WebWorkerMLCEngine {
  const create = vi.fn(async () =>
    (async function* () {
      for (const c of chunks) yield { choices: [{ index: 0, delta: { content: c } }] }
    })(),
  )
  return {
    chat: { completions: { create } },
    unload: vi.fn(async () => {}),
    interruptGenerate: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WebWorkerMLCEngine
}

beforeEach(() => {
  vi.stubGlobal('Worker', WorkerStub)
  vi.mocked(hasWebGpu).mockResolvedValue(true)
  vi.mocked(CreateWebWorkerMLCEngine).mockResolvedValue(fakeEngine())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('WebLlmEngine.isReady', () => {
  it('is false before load even with WebGPU', async () => {
    const engine = new WebLlmEngine({ modelId: MODEL })
    expect(await engine.isReady()).toBe(false)
  })

  it('is false without WebGPU even after load attempt', async () => {
    vi.mocked(hasWebGpu).mockResolvedValue(false)
    const engine = new WebLlmEngine({ modelId: MODEL })
    await expect(engine.load()).rejects.toMatchObject({ code: 'no-webgpu' })
    expect(await engine.isReady()).toBe(false)
  })
})

describe('WebLlmEngine.load', () => {
  it('constructs the worker engine with modelId + opfs appConfig', async () => {
    const engine = new WebLlmEngine({ modelId: MODEL })
    const onLoadProgress = vi.fn()
    await engine.load(onLoadProgress)

    expect(CreateWebWorkerMLCEngine).toHaveBeenCalledWith(
      expect.any(WorkerStub),
      MODEL,
      expect.objectContaining({
        appConfig: expect.objectContaining({ cacheBackend: 'opfs' }),
        initProgressCallback: expect.any(Function),
      }),
    )
    // initProgressCallback wired to onLoadProgress
    const cfg = vi.mocked(CreateWebWorkerMLCEngine).mock.calls[0]?.[2] as {
      initProgressCallback: (r: { progress: number }) => void
    }
    cfg.initProgressCallback({ progress: 0.5 })
    expect(onLoadProgress).toHaveBeenCalledWith(0.5)
    expect(await engine.isReady()).toBe(true)
  })

  it('tears down on load failure', async () => {
    vi.mocked(CreateWebWorkerMLCEngine).mockRejectedValue(new Error('boom'))
    const engine = new WebLlmEngine({ modelId: MODEL })
    await expect(engine.load()).rejects.toMatchObject({ code: 'load-failed' })
    expect(await engine.isReady()).toBe(false)
  })

  it('is idempotent (second load is a no-op)', async () => {
    const engine = new WebLlmEngine({ modelId: MODEL })
    await engine.load()
    await engine.load()
    expect(CreateWebWorkerMLCEngine).toHaveBeenCalledTimes(1)
  })
})

describe('WebLlmEngine.transform', () => {
  it('streams a completion per chunk and assembles output', async () => {
    const proxy = fakeEngine(['He', 'llo'])
    vi.mocked(CreateWebWorkerMLCEngine).mockResolvedValue(proxy)
    const engine = new WebLlmEngine({ modelId: MODEL })
    await engine.load()

    const out = await engine.transform(['a', 'b'], { kind: 'cleanup' })
    expect(out).toEqual(['Hello', 'Hello'])
    expect(proxy.chat.completions.create).toHaveBeenCalledTimes(2)
  })

  it('throws WebLlmError(not-loaded) before load', async () => {
    const engine = new WebLlmEngine({ modelId: MODEL })
    await expect(engine.transform(['a'], { kind: 'cleanup' })).rejects.toMatchObject({
      code: 'not-loaded',
    })
  })
})

describe('WebLlmEngine — abort bridge', () => {
  it('a pre-aborted signal calls interruptGenerate and rejects', async () => {
    const proxy = fakeEngine()
    vi.mocked(CreateWebWorkerMLCEngine).mockResolvedValue(proxy)
    const engine = new WebLlmEngine({ modelId: MODEL })
    await engine.load()

    const ac = new AbortController()
    ac.abort()
    await expect(
      engine.transform(['a'], { kind: 'cleanup' }, undefined, ac.signal),
    ).rejects.toThrow()
    expect(proxy.interruptGenerate).toHaveBeenCalled()
  })
})

describe('WebLlmEngine — idle teardown', () => {
  it('unloads + terminates after the idle grace period', async () => {
    const proxy = fakeEngine()
    vi.mocked(CreateWebWorkerMLCEngine).mockResolvedValue(proxy)
    const engine = new WebLlmEngine({ modelId: MODEL, idleMs: 10 })
    await engine.load()

    await new Promise((r) => setTimeout(r, 30))
    expect(proxy.unload).toHaveBeenCalled()
    expect(await engine.isReady()).toBe(false)
  })
})

describe('WebLlmError', () => {
  it('carries a typed code', () => {
    expect(new WebLlmError('no-webgpu', 'x').code).toBe('no-webgpu')
  })
})
