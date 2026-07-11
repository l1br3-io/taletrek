import { afterEach, describe, expect, it, vi } from 'vitest'
import { voiceId } from '../../types'
import { _resetWorkerForTests, TtsClient } from './client'
import type { TtsRequest, TtsResponse } from './protocol'

const VOICE = voiceId('en_US-hfc_female-medium')

class WorkerStub {
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>()
  lastRequest: TtsRequest | null = null

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
    this.lastRequest = msg as TtsRequest
  }

  emit(msg: TtsResponse): void {
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

/** The correlation id of the last posted request, throwing if none was posted. */
function lastId(): number {
  const id = current?.lastRequest?.id
  if (id === undefined) throw new Error('no request posted')
  return id
}

afterEach(() => {
  current = null
  _resetWorkerForTests()
  vi.unstubAllGlobals()
})

describe('TtsClient', () => {
  it('listVoices returns the static catalog without a worker round-trip', async () => {
    const client = new TtsClient()
    const voices = await client.listVoices()
    expect(voices).toHaveLength(8)
    expect(voices[0]?.id).toBe(VOICE)
  })

  it('synthesize posts the request and resolves with audio + timing', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    const wav = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/x-wav' })
    const pending = client.synthesize({ text: 'hello', voiceId: VOICE })
    await flushPosted()
    expect(current?.lastRequest?.op).toBe('synthesize')
    current?.emit({ id: lastId(), type: 'success', op: 'synthesize', audio: wav, synthMs: 42 })
    const result = await pending
    expect(result.audio).toBe(wav)
    expect(result.synthMs).toBe(42)
  })

  it('download streams progress then resolves', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    const progress: number[] = []
    const pending = client.download(VOICE, (f) => progress.push(f))
    await flushPosted()
    current?.emit({ id: lastId(), type: 'progress', fraction: 0.5 })
    current?.emit({ id: lastId(), type: 'progress', fraction: 1 })
    current?.emit({ id: lastId(), type: 'success', op: 'download' })
    await pending
    expect(progress).toEqual([0.5, 1])
  })

  it('isStored resolves with the boolean', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    const pending = client.isStored(VOICE)
    await flushPosted()
    current?.emit({ id: lastId(), type: 'success', op: 'isStored', stored: true })
    await expect(pending).resolves.toBe(true)
  })

  it('rejects with an error message on failure', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    const pending = client.synthesize({ text: 'x', voiceId: VOICE })
    await flushPosted()
    current?.emit({ id: lastId(), type: 'error', message: 'model not downloaded' })
    await expect(pending).rejects.toThrow('model not downloaded')
  })

  it('ignores responses with a mismatched id', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    const wav = new Blob([new Uint8Array([0])], { type: 'audio/x-wav' })
    const pending = client.synthesize({ text: 'hi', voiceId: VOICE })
    await flushPosted()
    current?.emit({ id: 999, type: 'success', op: 'synthesize', audio: wav, synthMs: 1 })
    current?.emit({ id: lastId(), type: 'success', op: 'synthesize', audio: wav, synthMs: 7 })
    const result = await pending
    expect(result.synthMs).toBe(7)
  })
})
