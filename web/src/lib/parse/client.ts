import type { ParseRequest, ParseResponse } from './protocol'
import type { ParseResult } from './types'

let worker: Worker | null = null
let nextId = 1

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/parse.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

/** Reset the memoized worker — test-only escape hatch. */
export function _resetWorkerForTests(): void {
  worker = null
}

export function parseInWorker(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const w = getWorker()
    const onMessage = (event: MessageEvent<ParseResponse>) => {
      const msg = event.data
      if (msg.id !== id) return
      w.removeEventListener('message', onMessage)
      if (msg.type === 'success') resolve(msg.result)
      else reject(new Error(msg.message))
    }
    w.addEventListener('message', onMessage)
    void (async () => {
      try {
        const buffer = await file.arrayBuffer()
        const request: ParseRequest = { id, buffer, name: file.name, type: file.type }
        w.postMessage(request, [buffer])
      } catch (error) {
        w.removeEventListener('message', onMessage)
        reject(
          new Error(
            error instanceof Error
              ? `Could not read file: ${error.message}`
              : 'Could not read file',
          ),
        )
      }
    })()
  })
}
