import type { VoiceId } from '../../types'
import { formatError } from '../format-error'
import type { TtsRequest, TtsRequestBody, TtsResponse, TtsSuccess } from './protocol'
import type { SynthesisRequest, SynthesisResult, TtsEngine, Voice } from './types'
import { CURATED_VOICES } from './voices'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<
  number,
  {
    resolve: (value: TtsSuccess) => void
    reject: (reason: Error) => void
    onProgress?: (fraction: number) => void
  }
>()

/**
 * Whether a worker-level error is "fatal" — i.e. the Piper session is in a
 * permanently broken state and every subsequent predict will keep failing
 * the same way. When true, the client queues a `resetEngine` request before
 * the next synth so the worker re-initializes the model + Emscripten MEMFS.
 *
 * Conservative: PARSE_ERROR is intentionally NOT fatal — per the user's log
 * sequence, predict() still succeeds (synth done is logged) when PARSE_ERROR
 * fires as a worker-level rejection. Treating it as fatal would cause
 * needless 4s model reloads on every paragraph.
 */
const FATAL_WORKER_ERROR_NAMES = new Set([
  'NotFoundError', // Emscripten MEMFS: /espeak-ng-data disappeared — session permanently broken
  'InvalidStateError', // WASM module in an invalid state (post-crash)
  'DataError', // model tensor data unparseable
  'InternalError', // WASM trap / unreachable
])

/** Set by `workerError` handler when a fatal error arrives. Cleared once the
 * reset request completes. Drains via {@link maybeRecycleBeforeNext}. */
let needsEngineReset = false

function makeWorkerError(msg: Extract<TtsResponse, { type: 'error' }>): Error {
  if (msg.name) {
    try {
      return new DOMException(msg.message, msg.name)
    } catch (domErr) {
      console.warn('[taletrek] tts client: could not reconstruct DOMException', {
        workerName: msg.name,
        workerCode: msg.code,
        workerMessage: msg.message,
        domConstructorError: (domErr as Error).message,
      })
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

function handleWorkerMessage(event: MessageEvent<TtsResponse>): void {
  const msg = event.data

  // Worker-level error (not correlated to a request). Logged loudly so vConsole
  // on iOS surfaces it — without this the worker's unhandled rejections show up
  // as anonymous `DomException PARSE_ERROR` with no source. We deliberately do
  // NOT reject pending requests here: the worker is typically still functional
  // for in-flight requests (the rejection didn't break inference); rejecting
  // would surface as a spurious synth failure. The pending request will either
  // resolve on its own or hit the watchdog timeout in `preSynthesizeBook`.
  if (msg.type === 'workerError') {
    console.error('[taletrek] tts client: worker-level error forwarded', {
      source: msg.source,
      name: msg.name,
      code: msg.code,
      message: msg.message,
      filename: msg.filename,
      lineno: msg.lineno,
      stack: msg.stack,
      pendingRequests: pending.size,
    })
    // Flag fatal errors so the next synth drains via `resetEngine` before
    // posting its request. Non-fatal (e.g. PARSE_ERROR) leaves the flag
    // alone — predict still succeeds despite the rejection noise.
    if (msg.name && FATAL_WORKER_ERROR_NAMES.has(msg.name) && !needsEngineReset) {
      console.error(
        '[taletrek] tts client: fatal worker error — engine will recycle on next synth',
        {
          name: msg.name,
        },
      )
      needsEngineReset = true
    }
    return
  }

  const entry = pending.get(msg.id)
  if (!entry) return

  if (msg.type === 'progress') {
    entry.onProgress?.(msg.fraction)
    return
  }

  pending.delete(msg.id)
  if (msg.type === 'success') {
    entry.resolve(msg)
  } else {
    console.error('[taletrek] tts client: worker error response', {
      id: msg.id,
      workerName: msg.name,
      workerCode: msg.code,
      workerMessage: msg.message,
    })
    entry.reject(makeWorkerError(msg))
  }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/tts.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.addEventListener('error', (e) => {
      // `e` is an ErrorEvent whose properties are prototype getters — passing
      // it raw to console.* makes vConsole mask them as `(PARSE_ERROR)`. Pull
      // the primitive fields out explicitly + append a formatError summary.
      console.error(
        '[taletrek] tts worker crashed:',
        e.message,
        e.filename,
        e.lineno,
        formatError(e.error),
      )
      rejectAllPending(new Error(`tts worker crashed: ${e.message}`))
      worker = null
      // Fresh worker on next getWorker() — clear the reset flag so we don't
      // send a redundant resetEngine before the first synth (the new worker
      // starts with no session cached).
      needsEngineReset = false
    })
    worker.addEventListener('messageerror', (e) => {
      console.error('[taletrek] tts worker message error:', e.type)
      rejectAllPending(new Error('tts worker message error'))
      worker = null
      needsEngineReset = false
    })
    worker.addEventListener('message', handleWorkerMessage)
  }
  return worker
}

/** Reset the memoized worker — test-only escape hatch. */
export function _resetWorkerForTests(): void {
  worker = null
  pending.clear()
  needsEngineReset = false
}

function request(
  req: TtsRequestBody,
  onProgress?: (fraction: number) => void,
): Promise<TtsSuccess> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, onProgress })
    getWorker().postMessage({ id, ...req } as TtsRequest)
  })
}

/**
 * Send a `resetEngine` request to the worker if a fatal worker-level error
 * has been observed since the last reset. Resolves immediately if no reset
 * is needed. Called before every `synthesize` so a broken session can't
 * poison the next paragraph — the worker drops its cached `TtsSession` and
 * the synth request re-creates it from scratch (re-loading the model + the
 * Emscripten MEMFS data files).
 */
async function maybeRecycleBeforeNext(): Promise<void> {
  if (!needsEngineReset) return
  needsEngineReset = false
  console.warn('[taletrek] tts client: sending resetEngine before next synth')
  try {
    await request({ op: 'resetEngine' })
  } catch (err) {
    // The reset itself failed — log and continue. The upcoming synth may
    // still work (the reset is best-effort recovery), and if it doesn't,
    // the synth timeout will catch it.
    console.error('[taletrek] tts client: resetEngine failed', {
      errName: (err as Error).name,
      errMessage: (err as Error).message,
    })
  }
}

/**
 * Main-thread `TtsEngine` backed by the TTS Web Worker. `listVoices` returns
 * the static catalog directly (no worker round-trip); the other ops delegate
 * to the worker, which holds the Piper model resident.
 */
export class TtsClient implements TtsEngine {
  async listVoices(): Promise<Voice[]> {
    return [...CURATED_VOICES]
  }

  async isStored(voiceId: VoiceId): Promise<boolean> {
    const res = await request({ op: 'isStored', voiceId })
    if (res.op !== 'isStored') throw new Error(`unexpected response op: ${res.op}`)
    return res.stored
  }

  async download(voiceId: VoiceId, onProgress?: (fraction: number) => void): Promise<void> {
    const res = await request({ op: 'download', voiceId }, onProgress)
    if (res.op !== 'download') throw new Error(`unexpected response op: ${res.op}`)
  }

  async remove(voiceId: VoiceId): Promise<void> {
    const res = await request({ op: 'remove', voiceId })
    if (res.op !== 'remove') throw new Error(`unexpected response op: ${res.op}`)
  }

  async clearAllStored(): Promise<void> {
    const res = await request({ op: 'clearAllStored' })
    if (res.op !== 'clearAllStored') throw new Error(`unexpected response op: ${res.op}`)
  }

  /**
   * Explicitly recycle the worker's Piper session. Exposed so callers outside
   * the synth hot-path (e.g. a "Reset TTS engine" settings action, or a
   * pre-upload health check) can force a fresh model init. The flag-set path
   * is also what the worker-error handler uses; this method just sets the
   * same flag and lets the next synth drain it.
   */
  recycle(): void {
    needsEngineReset = true
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    // Drain any pending engine reset before synth — a fatal worker-level
    // error (NotFoundError, etc.) means the cached Piper session is broken
    // and would fail predict() the same way. Resetting first gives the
    // synth a fresh session. Cheap when no reset is flagged (single boolean
    // check); ~4s model reload when it is.
    await maybeRecycleBeforeNext()
    const t0 = performance.now()
    console.log('[taletrek] tts client: synthesize request', {
      textLen: req.text.length,
      voiceId: req.voiceId,
      returnAudio: req.returnAudio,
      ...(req.bookId !== undefined ? { bookId: req.bookId } : {}),
    })
    let res: TtsSuccess
    try {
      res = await request({
        op: 'synthesize',
        text: req.text,
        voiceId: req.voiceId,
        returnAudio: req.returnAudio,
        ...(req.bookId !== undefined ? { bookId: req.bookId } : {}),
      })
    } catch (err) {
      console.error('[taletrek] tts client: synthesize rejected', {
        textLen: req.text.length,
        elapsedMs: Math.round(performance.now() - t0),
        errName: (err as Error).name,
        errCode: (err as DOMException).code,
        errConstructor: (err as object).constructor?.name,
        errMessage: (err as Error).message,
      })
      throw err
    }
    console.log('[taletrek] tts client: synthesize response', {
      textLen: req.text.length,
      op: res.op,
      elapsedMs: Math.round(performance.now() - t0),
    })
    if (res.op !== 'synthesize') throw new Error(`unexpected response op: ${res.op}`)
    return {
      audio: res.audio,
      synthMs: res.synthMs,
      durationSeconds: res.durationSeconds,
      cacheKey: res.cacheKey,
    }
  }
}

/**
 * Shared `TtsEngine` instance. The underlying worker is module-level (one
 * Piper model resident, shared by every consumer). Import this rather than
 * `new TtsClient()`.
 */
export const ttsClient: TtsEngine = new TtsClient()
