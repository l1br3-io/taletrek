import type { VoiceId } from '../../types'
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

function makeWorkerError(msg: Extract<TtsResponse, { type: 'error' }>): Error {
  if (msg.name) {
    try {
      return new DOMException(msg.message, msg.name)
    } catch {
      // DOMException constructor may throw for an invalid name; fall through.
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
    entry.reject(makeWorkerError(msg))
  }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/tts.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.addEventListener('error', (e) => {
      console.error('[taletrek] tts worker crashed:', e.message, e.filename, e.lineno, e)
      rejectAllPending(new Error(`tts worker crashed: ${e.message}`))
      worker = null
    })
    worker.addEventListener('messageerror', (e) => {
      console.error('[taletrek] tts worker message error:', e)
      rejectAllPending(new Error('tts worker message error'))
      worker = null
    })
    worker.addEventListener('message', handleWorkerMessage)
  }
  return worker
}

/** Reset the memoized worker — test-only escape hatch. */
export function _resetWorkerForTests(): void {
  worker = null
  pending.clear()
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

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const res = await request({
      op: 'synthesize',
      text: req.text,
      voiceId: req.voiceId,
      returnAudio: req.returnAudio,
      ...(req.bookId !== undefined ? { bookId: req.bookId } : {}),
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
