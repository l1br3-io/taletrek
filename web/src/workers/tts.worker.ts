import { formatError } from '../lib/format-error'
import { PiperEngine } from '../lib/tts/engine'
import type { TtsRequest, TtsResponse } from '../lib/tts/protocol'

console.log('[taletrek] tts worker: module loaded')

const ctx = self as unknown as Worker
const engine = new PiperEngine()

/**
 * Forward worker-level errors to the main thread so they are attributable in
 * vConsole on iOS. Piper's Emscripten `printErr` callback throws `new Error(msg)`
 * from inside the WASM boundary (piper-tts-web@1.0.4 inference.d.ts → predict);
 * when Emscripten emits a non-fatal stderr line, that throw becomes an unhandled
 * rejection rather than a `predict()` failure — visible on the main thread as
 * anonymous `DomException PARSE_ERROR` logs with no source. Posting a
 * `workerError` message lets the main thread log it with full context, and lets
 * a future watchdog decide whether to recycle the worker.
 *
 * Crucially: we do NOT call `ctx.close()` here. The worker is typically still
 * functional for subsequent requests (the rejection didn't break inference),
 * and tearing it down would discard the resident Piper model — a 4s reload.
 */
function forwardWorkerError(
  source: 'error' | 'unhandledrejection',
  payload: {
    message: string
    name?: string
    code?: number
    filename?: string
    lineno?: number
    colno?: number
    stack?: string
  },
): void {
  console.error(`[taletrek] tts worker: ${source} (forwarded)`, payload)
  const res: TtsResponse = { type: 'workerError', source, ...payload }
  ctx.postMessage(res)
}

self.addEventListener('error', (e: ErrorEvent) => {
  forwardWorkerError('error', {
    message: e.message || 'unknown error',
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error instanceof Error ? e.error.stack : undefined,
    name:
      e.error instanceof DOMException
        ? e.error.name
        : e.error instanceof Error
          ? e.error.name
          : undefined,
    code: e.error instanceof DOMException ? e.error.code : undefined,
  })
  // Prevent the default (which would kill the worker + propagate to the main
  // thread's `worker.addEventListener('error')` as a separate, redundant
  // event). We've already forwarded; main thread handles it from here.
  e.preventDefault()
})

self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason = e.reason
  const payload: {
    message: string
    name?: string
    code?: number
    stack?: string
  } = {
    message:
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'unknown unhandled rejection',
  }
  if (reason instanceof DOMException) {
    payload.name = reason.name
    payload.code = reason.code
  } else if (reason instanceof Error) {
    payload.name = reason.name
    payload.stack = reason.stack
  }
  forwardWorkerError('unhandledrejection', payload)
  e.preventDefault()
})

ctx.onmessage = async (event: MessageEvent<TtsRequest>) => {
  const req = event.data
  try {
    switch (req.op) {
      case 'synthesize': {
        const { audio, synthMs, durationSeconds, cacheKey } = await engine.synthesize({
          text: req.text,
          voiceId: req.voiceId,
          returnAudio: req.returnAudio,
          ...(req.bookId !== undefined ? { bookId: req.bookId } : {}),
        })
        const res: TtsResponse = {
          id: req.id,
          type: 'success',
          op: 'synthesize',
          audio,
          synthMs,
          durationSeconds,
          cacheKey,
        }
        ctx.postMessage(res)
        break
      }
      case 'download': {
        await engine.download(req.voiceId, (fraction) => {
          const res: TtsResponse = { id: req.id, type: 'progress', fraction }
          ctx.postMessage(res)
        })
        const res: TtsResponse = { id: req.id, type: 'success', op: 'download' }
        ctx.postMessage(res)
        break
      }
      case 'isStored': {
        const stored = await engine.isStored(req.voiceId)
        const res: TtsResponse = { id: req.id, type: 'success', op: 'isStored', stored }
        ctx.postMessage(res)
        break
      }
      case 'remove': {
        await engine.remove(req.voiceId)
        const res: TtsResponse = { id: req.id, type: 'success', op: 'remove' }
        ctx.postMessage(res)
        break
      }
      case 'clearAllStored': {
        await engine.clearAllStored()
        const res: TtsResponse = { id: req.id, type: 'success', op: 'clearAllStored' }
        ctx.postMessage(res)
        break
      }
      case 'resetEngine': {
        // Drop the cached Piper session + clear the package singleton so the
        // next op re-creates it from scratch. Recovery path for fatal
        // worker-level errors (`NotFoundError` from Emscripten MEMFS, etc.).
        engine.recycle()
        const res: TtsResponse = { id: req.id, type: 'success', op: 'resetEngine' }
        ctx.postMessage(res)
        break
      }
    }
  } catch (error) {
    // Pre-serialized string, not the raw error — vConsole renders prototype
    // getters as `(PARSE_ERROR)`. See `lib/format-error.ts`.
    console.error('[taletrek] tts worker error:', formatError(error))
    const res: TtsResponse = {
      id: req.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'unknown error',
      ...(error instanceof DOMException ? { name: error.name, code: error.code } : {}),
    }
    ctx.postMessage(res)
  }
}
