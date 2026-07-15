import type { ConcatRequest, ConcatResponse } from './concat-protocol'

let worker: Worker | null = null
let nextId = 1

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/concat.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

export function _resetConcatWorkerForTests(): void {
  worker?.terminate()
  worker = null
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
      const w = getWorker()
      const onMessage = (event: MessageEvent<ConcatResponse>) => {
        const msg = event.data
        if (msg.id !== id) return
        if (msg.type === 'loadProgress') {
          onProgress?.(msg.fraction)
          return
        }
        w.removeEventListener('message', onMessage)
        if (msg.type === 'loaded') resolve()
        else reject(new Error(`unexpected: ${msg.type}`))
      }
      w.addEventListener('message', onMessage)
      w.postMessage({ id, type: 'load' } satisfies ConcatRequest)
    })
    this.coreLoaded = true
  }

  async concat(keys: string[]): Promise<ConcatResult> {
    if (!this.coreLoaded) await this.loadCore()
    const id = nextId++
    return new Promise((resolve, reject) => {
      const w = getWorker()
      const onMessage = (event: MessageEvent<ConcatResponse>) => {
        const msg = event.data
        if (msg.id !== id) return
        w.removeEventListener('message', onMessage)
        if (msg.type === 'success') resolve(msg)
        else if (msg.type === 'error') reject(new Error(msg.message))
        else reject(new Error(`unexpected: ${msg.type}`))
      }
      w.addEventListener('message', onMessage)
      w.postMessage({ id, type: 'concat', keys } satisfies ConcatRequest)
    })
  }
}

export const concatClient = new ConcatClient()
