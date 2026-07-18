import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetConcatWorkerForTests, ConcatClient } from './concat-client'
import type { ConcatRequest, ConcatResponse } from './concat-protocol'

class WorkerStub {
  private listeners = new Map<string, Set<(e: Event) => void>>()
  lastRequest: ConcatRequest | null = null

  constructor() {
    current = this
  }

  addEventListener(type: string, fn: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(fn)
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  postMessage(msg: unknown): void {
    this.lastRequest = msg as ConcatRequest
  }

  terminate(): void {}

  emit(msg: ConcatResponse): void {
    const evt = { data: msg } as MessageEvent
    this.listeners.get('message')?.forEach((fn) => {
      fn(evt as unknown as Event)
    })
  }

  emitError(error: ErrorEventInit & { message?: string }): void {
    const evt = new ErrorEvent('error', error)
    this.listeners.get('error')?.forEach((fn) => {
      fn(evt)
    })
  }
}

let current: WorkerStub | null = null

function flushPosted(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function lastId(): number {
  const id = current?.lastRequest?.id
  if (id === undefined) throw new Error('no request posted')
  return id
}

afterEach(() => {
  current = null
  _resetConcatWorkerForTests()
  vi.unstubAllGlobals()
})

describe('ConcatClient', () => {
  it('loadCore resolves on loaded and streams progress', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new ConcatClient()
    const progress: number[] = []
    const pending = client.loadCore((f) => progress.push(f))
    await flushPosted()
    current?.emit({ id: lastId(), type: 'loadProgress', fraction: 0.5 })
    current?.emit({ id: lastId(), type: 'loadProgress', fraction: 1 })
    current?.emit({ id: lastId(), type: 'loaded' })
    await pending
    expect(progress).toEqual([0.5, 1])
    expect(client.isCoreLoaded).toBe(true)
  })

  it('concat resolves with the worker result', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new ConcatClient()
    client.loadCore = vi.fn().mockResolvedValue(undefined)
    const pending = client.concat(['k1', 'k2'])
    await flushPosted()
    current?.emit({
      id: lastId(),
      type: 'success',
      m4a: new ArrayBuffer(8),
      paragraphOffsets: [0, 1],
      durations: [1, 1],
      duration: 2,
    })
    const result = await pending
    expect(result.duration).toBe(2)
  })

  it('reconstructs a DOMException when the worker sends name + code', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new ConcatClient()
    client.loadCore = vi.fn().mockResolvedValue(undefined)
    const pending = client.concat(['k1'])
    await flushPosted()
    current?.emit({
      id: lastId(),
      type: 'error',
      message: 'quota exceeded',
      name: 'QuotaExceededError',
      code: 22,
    })
    await expect(pending).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === 'QuotaExceededError' && err.code === 22
    })
  })

  it('rejects pending requests when the worker crashes', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new ConcatClient()
    const pending = client.loadCore()
    await flushPosted()
    current?.emitError({ message: 'concat worker exploded' })
    await expect(pending).rejects.toThrow(/concat worker crashed/)
    expect(client.isCoreLoaded).toBe(false)
  })
})
