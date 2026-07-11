import type { VoiceId } from '../../types'
import type { TtsRequest, TtsRequestBody, TtsResponse, TtsSuccess } from './protocol'
import type { SynthesisRequest, SynthesisResult, TtsEngine, Voice } from './types'
import { CURATED_VOICES } from './voices'

let worker: Worker | null = null
let nextId = 1

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/tts.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

/** Reset the memoized worker — test-only escape hatch. */
export function _resetWorkerForTests(): void {
  worker = null
}

function request(
  req: TtsRequestBody,
  onProgress?: (fraction: number) => void,
): Promise<TtsSuccess> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const w = getWorker()
    const onMessage = (event: MessageEvent<TtsResponse>) => {
      const msg = event.data
      if (msg.id !== id) return
      if (msg.type === 'progress') {
        onProgress?.(msg.fraction)
        return
      }
      w.removeEventListener('message', onMessage)
      if (msg.type === 'success') resolve(msg)
      else reject(new Error(msg.message))
    }
    w.addEventListener('message', onMessage)
    w.postMessage({ id, ...req } as TtsRequest)
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

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const res = await request({ op: 'synthesize', text: req.text, voiceId: req.voiceId })
    if (res.op !== 'synthesize') throw new Error(`unexpected response op: ${res.op}`)
    return { audio: res.audio, synthMs: res.synthMs }
  }
}

/**
 * Shared `TtsEngine` instance. The underlying worker is module-level (one
 * Piper model resident, shared by every consumer). Import this rather than
 * `new TtsClient()`.
 */
export const ttsClient: TtsEngine = new TtsClient()
