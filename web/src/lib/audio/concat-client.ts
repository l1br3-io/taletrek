import type { ConcatRequest, ConcatResponse } from './concat-protocol'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void
    reject: (reason: Error) => void
    onProgress?: (fraction: number) => void
  }
>()

function makeWorkerError(msg: Extract<ConcatResponse, { type: 'error' }>): Error {
  if (msg.name) {
    try {
      return new DOMException(msg.message, msg.name)
    } catch {
      // Fall through.
    }
  }
  return new Error(msg.message)
}

function rejectAllPending(reason: Error): void {
  for (const [, { reject }] of pending) {
    reject(reason)
  }
  pending.clear()
}

function handleWorkerMessage(event: MessageEvent<ConcatResponse>): void {
  const msg = event.data
  const entry = pending.get(msg.id)
  if (!entry) return

  if (msg.type === 'loadProgress') {
    entry.onProgress?.(msg.fraction)
    return
  }

  pending.delete(msg.id)
  if (msg.type === 'loaded' || msg.type === 'success') {
    entry.resolve(msg)
  } else {
    entry.reject(makeWorkerError(msg))
  }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/concat.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.addEventListener('error', (e) => {
      console.error('[taletrek] concat worker crashed:', e.message, e.filename, e.lineno, e)
      rejectAllPending(new Error(`concat worker crashed: ${e.message}`))
      worker = null
    })
    worker.addEventListener('messageerror', (e) => {
      console.error('[taletrek] concat worker message error:', e)
      rejectAllPending(new Error('concat worker message error'))
      worker = null
    })
    worker.addEventListener('message', handleWorkerMessage)
  }
  return worker
}

export function _resetConcatWorkerForTests(): void {
  worker?.terminate()
  worker = null
  pending.clear()
}

export interface ConcatResult {
  m4a: ArrayBuffer
  paragraphOffsets: number[]
  durations: number[]
  duration: number
}

export class ConcatClient {
  private coreLoaded = false

  get isCoreLoaded(): boolean {
    return this.coreLoaded
  }

  async loadCore(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.coreLoaded) return
    const id = nextId++
    await new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress })
      getWorker().postMessage({ id, type: 'load' } satisfies ConcatRequest)
    })
    this.coreLoaded = true
  }

  async concat(keys: string[]): Promise<ConcatResult> {
    if (!this.coreLoaded) await this.loadCore()
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      getWorker().postMessage({ id, type: 'concat', keys } satisfies ConcatRequest)
    }) as Promise<ConcatResult>
  }
}

export const concatClient = new ConcatClient()
