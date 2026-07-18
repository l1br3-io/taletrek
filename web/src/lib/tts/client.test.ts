import { afterEach, describe, expect, it, vi } from 'vitest'
import { voiceId } from '../../types'
import { _resetWorkerForTests, TtsClient } from './client'
import type { TtsRequest, TtsResponse } from './protocol'

const VOICE = voiceId('en_US-hfc_female-medium')

class WorkerStub {
  private listeners = new Map<string, Set<(e: Event) => void>>()
  lastRequest: TtsRequest | null = null

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
    this.lastRequest = msg as TtsRequest
  }

  emit(msg: TtsResponse): void {
    const evt = { data: msg } as MessageEvent
    this.listeners.get('message')?.forEach((fn) => {
      fn(evt)
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
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: wav,
      synthMs: 42,
      durationSeconds: 1,
      cacheKey: 'k',
    })
    const result = await pending
    expect(result.audio).toBe(wav)
    expect(result.synthMs).toBe(42)
    expect(result.durationSeconds).toBe(1)
    expect(result.cacheKey).toBe('k')
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

  it('reconstructs a DOMException when the worker sends name + code', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    const pending = client.synthesize({ text: 'x', voiceId: VOICE })
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
    const client = new TtsClient()
    const pending = client.synthesize({ text: 'x', voiceId: VOICE })
    await flushPosted()
    current?.emitError({ message: 'worker exploded' })
    await expect(pending).rejects.toThrow(/worker crashed/)
  })

  it('forwards workerError messages without rejecting in-flight requests', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = client.synthesize({ text: 'x', voiceId: VOICE })
    await flushPosted()

    // A worker-level unhandled rejection (e.g. Piper's printErr throw) arrives
    // while a synth is in flight. The client must log it but NOT reject the
    // pending request — the rejection didn't break inference, and rejecting
    // would surface as a spurious synth failure.
    current?.emit({
      type: 'workerError',
      source: 'unhandledrejection',
      message: 'PARSE_ERROR: ...',
      name: 'PARSE_ERROR',
    })

    expect(warnSpy).toHaveBeenCalledWith(
      '[taletrek] tts client: worker-level error forwarded',
      expect.objectContaining({
        source: 'unhandledrejection',
        name: 'PARSE_ERROR',
        message: 'PARSE_ERROR: ...',
      }),
    )

    // The in-flight synth should still resolve normally when its response arrives.
    const wav = new Blob([new Uint8Array([1])], { type: 'audio/x-wav' })
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: wav,
      synthMs: 5,
      durationSeconds: 1,
      cacheKey: 'k',
    })
    await expect(pending).resolves.toMatchObject({ synthMs: 5 })
    warnSpy.mockRestore()
  })

  it('does NOT recycle on a non-fatal workerError (PARSE_ERROR)', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Bootstrap the worker first — `current` is null until a worker-creating
    // call happens, so emitting a workerError before that is a no-op.
    const bootSynth = client.synthesize({ text: 'boot', voiceId: VOICE })
    await flushPosted()
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: new Blob([new Uint8Array([0])]),
      synthMs: 1,
      durationSeconds: 1,
      cacheKey: 'k0',
    })
    await bootSynth

    // PARSE_ERROR fires; per the user's logs, predict() still succeeds with
    // this error as a worker-level side effect, so we must not trigger a
    // 4s model reload on every paragraph.
    current?.emit({
      type: 'workerError',
      source: 'unhandledrejection',
      message: 'PARSE_ERROR: ...',
      name: 'PARSE_ERROR',
    })
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('sending resetEngine'),
      expect.anything(),
    )

    // Next synth should go straight through without a preceding resetEngine.
    const synthPending = client.synthesize({ text: 'x', voiceId: VOICE })
    await flushPosted()
    expect(current?.lastRequest?.op).toBe('synthesize')
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: new Blob([new Uint8Array([1])]),
      synthMs: 5,
      durationSeconds: 1,
      cacheKey: 'k',
    })
    await synthPending
  })

  it('recycles the engine before the next synth after a fatal NotFoundError', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Bootstrap the worker so we can deliver a workerError message.
    const bootSynth = client.synthesize({ text: 'boot', voiceId: VOICE })
    await flushPosted()
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: new Blob([new Uint8Array([0])]),
      synthMs: 1,
      durationSeconds: 1,
      cacheKey: 'k0',
    })
    await bootSynth

    // Fatal MEMFS error — Emscripten can't find /espeak-ng-data. The session
    // is permanently broken and would fail every subsequent predict the same
    // way; flag for recycle.
    current?.emit({
      type: 'workerError',
      source: 'unhandledrejection',
      message: 'Object cannot be found here',
      name: 'NotFoundError',
    })

    // Next synth must first send resetEngine (drain the flag), THEN synthesize.
    const synthPending = client.synthesize({ text: 'x', voiceId: VOICE })
    await flushPosted()
    expect(current?.lastRequest?.op).toBe('resetEngine')
    expect(warnSpy).toHaveBeenCalledWith(
      '[taletrek] tts client: sending resetEngine before next synth',
    )

    // Worker acks the reset.
    current?.emit({ id: lastId(), type: 'success', op: 'resetEngine' })
    await flushPosted()
    // Now the synth request itself goes out.
    expect(current?.lastRequest?.op).toBe('synthesize')
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: new Blob([new Uint8Array([1])]),
      synthMs: 5,
      durationSeconds: 1,
      cacheKey: 'k',
    })
    await synthPending

    // Flag is drained — a subsequent synth should NOT trigger another reset.
    warnSpy.mockClear()
    const synth2 = client.synthesize({ text: 'y', voiceId: VOICE })
    await flushPosted()
    expect(current?.lastRequest?.op).toBe('synthesize')
    expect(warnSpy).not.toHaveBeenCalled()
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: new Blob([new Uint8Array([2])]),
      synthMs: 6,
      durationSeconds: 1,
      cacheKey: 'k2',
    })
    await synth2
  })

  it('continues synthesizing if resetEngine itself fails', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Bootstrap the worker.
    const bootSynth = client.synthesize({ text: 'boot', voiceId: VOICE })
    await flushPosted()
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: new Blob([new Uint8Array([0])]),
      synthMs: 1,
      durationSeconds: 1,
      cacheKey: 'k0',
    })
    await bootSynth

    // Flag a fatal error.
    current?.emit({
      type: 'workerError',
      source: 'error',
      message: 'boom',
      name: 'InvalidStateError',
    })

    const synthPending = client.synthesize({ text: 'x', voiceId: VOICE })
    await flushPosted()
    expect(current?.lastRequest?.op).toBe('resetEngine')

    // The reset itself fails (worker is in a really bad state).
    current?.emit({
      id: lastId(),
      type: 'error',
      message: 'reset failed',
      name: 'InvalidStateError',
    })
    await flushPosted()

    // Synth should still be attempted (best-effort) — it may or may not work,
    // but the synth-timeout in pre-synth will catch a hang either way.
    expect(current?.lastRequest?.op).toBe('synthesize')
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: new Blob([new Uint8Array([3])]),
      synthMs: 7,
      durationSeconds: 1,
      cacheKey: 'k3',
    })
    await expect(synthPending).resolves.toMatchObject({ synthMs: 7 })
  })

  it('ignores responses with a mismatched id', async () => {
    vi.stubGlobal('Worker', WorkerStub)
    const client = new TtsClient()
    const wav = new Blob([new Uint8Array([0])], { type: 'audio/x-wav' })
    const pending = client.synthesize({ text: 'hi', voiceId: VOICE })
    await flushPosted()
    current?.emit({
      id: 999,
      type: 'success',
      op: 'synthesize',
      audio: wav,
      synthMs: 1,
      durationSeconds: 1,
      cacheKey: 'k',
    })
    current?.emit({
      id: lastId(),
      type: 'success',
      op: 'synthesize',
      audio: wav,
      synthMs: 7,
      durationSeconds: 1,
      cacheKey: 'k',
    })
    const result = await pending
    expect(result.synthMs).toBe(7)
  })
})
