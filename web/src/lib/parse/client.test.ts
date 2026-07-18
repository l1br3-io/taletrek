import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WakeLockHandle } from '../wake-lock'

const acquireUploadWakeLock = vi.fn<() => Promise<WakeLockHandle>>()
const releaseMock = vi.fn<() => Promise<void>>()
vi.mock('../wake-lock', () => ({
  acquireUploadWakeLock: () => acquireUploadWakeLock(),
}))

import { _resetWorkerForTests, parseInWorker } from './client'
import type { ParseRequest } from './protocol'

class WorkerStub {
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>()
  request: ParseRequest | null = null

  constructor() {
    current = this
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(fn)
  }

  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  postMessage(msg: unknown): void {
    this.request = msg as ParseRequest
  }

  emit(msg: unknown): void {
    const evt = { data: msg } as MessageEvent
    this.listeners.get('message')?.forEach((fn) => {
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

afterEach(() => {
  current = null
  _resetWorkerForTests()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  acquireUploadWakeLock.mockReset()
  releaseMock.mockReset()
  acquireUploadWakeLock.mockResolvedValue({ release: releaseMock })
})

describe('parseInWorker', () => {
  it('resolves with the parsed result on success', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const file = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const pending = parseInWorker(file)
    await flushPosted()
    const id = current?.request?.id
    const result = { title: 'a', chapters: [{ title: 'a', paragraphs: ['hi'] }] }
    current?.emit({ id, type: 'success', result })
    await expect(pending).resolves.toEqual(result)
    expect(acquireUploadWakeLock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('rejects with an error message on failure', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const file = new File(['x'], 'bad.unknown', { type: 'application/octet-stream' })
    const pending = parseInWorker(file)
    await flushPosted()
    const id = current?.request?.id
    current?.emit({ id, type: 'error', message: 'Unsupported file type: bad.unknown' })
    await expect(pending).rejects.toThrow('Unsupported file type: bad.unknown')
    expect(acquireUploadWakeLock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('ignores responses with a mismatched id', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const file = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const pending = parseInWorker(file)
    await flushPosted()
    current?.emit({ id: 999, type: 'success', result: { title: 'wrong', chapters: [] } })
    const id = current?.request?.id
    const result = { title: 'a', chapters: [{ title: 'a', paragraphs: ['hi'] }] }
    current?.emit({ id, type: 'success', result })
    await expect(pending).resolves.toEqual(result)
  })
})
