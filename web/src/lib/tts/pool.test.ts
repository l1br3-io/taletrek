import { afterEach, describe, expect, it, vi } from 'vitest'
import { voiceId } from '../../types'
import type { TtsRequest, TtsResponse } from './protocol'
import { PoolEngine } from './pool'
import type { TtsEngine, Voice } from './types'

const VOICE = voiceId('en_US-hfc_female-medium')

/**
 * Worker stub that records the most recent postMessage and lets the test
 * emit messages back. One stub instance = one worker = one slot in the pool.
 *
 * The pool's `createWorker` factory returns stubs in order, so a test can
 * reach into `stubs[i]` to drive the i-th spawned worker.
 */
class WorkerStub {
  private listeners = new Map<string, Set<(e: Event) => void>>()
  lastRequest: TtsRequest | null = null
  postedRequests: TtsRequest[] = []
  terminated = false

  addEventListener(type: string, fn: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(fn)
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  postMessage(msg: unknown): void {
    const req = msg as TtsRequest
    this.lastRequest = req
    this.postedRequests.push(req)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(msg: TtsResponse): void {
    const evt = { data: msg } as MessageEvent
    this.listeners.get('message')?.forEach((fn) => fn(evt))
  }

  emitError(error: ErrorEventInit & { message?: string }): void {
    const evt = new ErrorEvent('error', error)
    this.listeners.get('error')?.forEach((fn) => fn(evt))
  }
}

/**
 * The pool only posts `synthesize` ops (voice mgmt goes via the singleton
 * voiceEngine), so every posted request in tests is the synthesize variant.
 * This helper narrows the union so tests can read `.text` without a cast.
 */
function synthTexts(slot: WorkerStub): string[] {
  return slot.postedRequests.map((r) => (r.op === 'synthesize' ? r.text : `<${r.op}>`))
}

/** Returns the id of the most-recently-posted request, throwing if none. */
function lastId(slot: WorkerStub): number {
  const id = slot.lastRequest?.id
  if (id === undefined) throw new Error('no request posted')
  return id
}

/** Builds a stub-Worker factory that hands out stubs and tracks them. */
function stubWorkerFactory(): { create: () => Worker; stubs: WorkerStub[] } {
  const stubs: WorkerStub[] = []
  const create = (): Worker => {
    const stub = new WorkerStub()
    stubs.push(stub)
    return stub as unknown as Worker
  }
  return { create, stubs }
}

/** Minimal voice-engine stub for delegation checks (listVoices/isStored/etc). */
function makeVoiceEngineStub(): TtsEngine & {
  calls: string[]
} {
  const calls: string[] = []
  const voice: Voice = {
    id: VOICE,
    name: 'HFC Female',
    quality: 'medium',
    sizeBytes: 63_201_294,
    language: 'en_US',
  }
  return {
    async listVoices() {
      calls.push('listVoices')
      return [voice]
    },
    async isStored() {
      calls.push('isStored')
      return true
    },
    async download() {
      calls.push('download')
    },
    async remove() {
      calls.push('remove')
    },
    async clearAllStored() {
      calls.push('clearAllStored')
    },
    async synthesize() {
      calls.push('synthesize')
      throw new Error('voiceEngine.synthesize should not be called on a pool')
    },
    calls,
  }
}

function flushPosted(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function makeSynthSuccess(id: number): TtsResponse {
  return {
    id,
    type: 'success',
    op: 'synthesize',
    audio: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/x-wav' }),
    synthMs: 42,
    durationSeconds: 1.5,
    cacheKey: `k${id}`,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PoolEngine', () => {
  it('delegates voice-management ops to the voiceEngine', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create } = stubWorkerFactory()
    const pool = new PoolEngine(2, voiceEngine, { createWorker: create })
    await pool.listVoices()
    await pool.isStored(VOICE)
    await pool.download(VOICE)
    await pool.remove(VOICE)
    await pool.clearAllStored()
    expect(voiceEngine.calls).toEqual([
      'listVoices',
      'isStored',
      'download',
      'remove',
      'clearAllStored',
    ])
    pool.dispose()
  })

  it('spawns one worker for the first synth and dispatches to it', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(2, voiceEngine, { createWorker: create })

    const pending = pool.synthesize({ text: 'hello', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(1)
    expect(stubs[0]?.lastRequest?.op).toBe('synthesize')
    expect(synthTexts(stubs[0]!)).toEqual(['hello'])
    stubs[0]?.emit(makeSynthSuccess(lastId(stubs[0]!)))
    const result = await pending
    expect(result.synthMs).toBe(42)
    expect(result.cacheKey).toBe(`k${lastId(stubs[0]!)}`)
    pool.dispose()
  })

  it('lazy-grows the pool up to the cap as parallel synths arrive', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(3, voiceEngine, { createWorker: create })

    // Dispatch three in parallel; expect three workers spawned.
    const p1 = pool.synthesize({ text: 'one', voiceId: VOICE })
    const p2 = pool.synthesize({ text: 'two', voiceId: VOICE })
    const p3 = pool.synthesize({ text: 'three', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(3)
    expect(synthTexts(stubs[0]!)).toEqual(['one'])
    expect(synthTexts(stubs[1]!)).toEqual(['two'])
    expect(synthTexts(stubs[2]!)).toEqual(['three'])

    // Complete in reverse order — out-of-order resolves must still resolve the
    // right caller (correlation by id).
    stubs[2]?.emit(makeSynthSuccess(lastId(stubs[2]!)))
    stubs[1]?.emit(makeSynthSuccess(lastId(stubs[1]!)))
    stubs[0]?.emit(makeSynthSuccess(lastId(stubs[0]!)))

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.cacheKey).toBe(`k${lastId(stubs[0]!)}`)
    expect(r2.cacheKey).toBe(`k${lastId(stubs[1]!)}`)
    expect(r3.cacheKey).toBe(`k${lastId(stubs[2]!)}`)
    pool.dispose()
  })

  it('does NOT spawn a second worker when the first is idle (cache hit / fast resolve)', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(2, voiceEngine, { createWorker: create })

    const p1 = pool.synthesize({ text: 'one', voiceId: VOICE })
    await flushPosted()
    stubs[0]?.emit(makeSynthSuccess(lastId(stubs[0]!)))
    await p1

    // Second dispatch — worker 0 is idle (pending=0), so we should reuse it
    // rather than spawning worker 1.
    const p2 = pool.synthesize({ text: 'two', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(1)
    stubs[0]?.emit(makeSynthSuccess(lastId(stubs[0]!)))
    await p2
    pool.dispose()
  })

  it('caps at `size` workers under sustained load and dispatches least-busy', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(2, voiceEngine, { createWorker: create })

    // Dispatch 5 in parallel; cap is 2 so only 2 workers spawn. postMessage is
    // non-blocking, so all 5 requests are posted immediately — distributed
    // least-busy across the two slots (3 to slot 0, 2 to slot 1 by the
    // tie-break-pick-first rule).
    const ps = [
      pool.synthesize({ text: 'a', voiceId: VOICE }),
      pool.synthesize({ text: 'b', voiceId: VOICE }),
      pool.synthesize({ text: 'c', voiceId: VOICE }),
      pool.synthesize({ text: 'd', voiceId: VOICE }),
      pool.synthesize({ text: 'e', voiceId: VOICE }),
    ]
    await flushPosted()
    expect(stubs).toHaveLength(2)
    // Least-busy distribution: 3+2 (tie-break picks the lower index).
    expect(stubs[0]?.postedRequests).toHaveLength(3)
    expect(synthTexts(stubs[0]!)).toEqual(['a', 'c', 'e'])
    expect(stubs[1]?.postedRequests).toHaveLength(2)
    expect(synthTexts(stubs[1]!)).toEqual(['b', 'd'])

    // Resolving each posted request resolves its caller (correlation by id).
    for (const req of stubs[0]!.postedRequests) {
      stubs[0]?.emit(makeSynthSuccess(req.id))
    }
    for (const req of stubs[1]!.postedRequests) {
      stubs[1]?.emit(makeSynthSuccess(req.id))
    }
    const results = await Promise.all(ps)
    expect(results.map((r) => r.synthMs)).toEqual([42, 42, 42, 42, 42])
    pool.dispose()
  })

  it('rejects in-flight requests on the crashed worker and respawns on next dispatch', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(2, voiceEngine, { createWorker: create })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const p1 = pool.synthesize({ text: 'one', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(1)

    // Crash worker 0 with an in-flight request pending.
    stubs[0]?.emitError({ message: 'wasm exploded' })
    await expect(p1).rejects.toThrow(/worker 0 crashed/)

    // Next dispatch should respawn a fresh worker at slot 0 (cap is still 2).
    const p2 = pool.synthesize({ text: 'two', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(2) // a new stub was created on respawn
    expect(stubs[1]?.terminated).toBe(false)
    expect(synthTexts(stubs[1]!)).toEqual(['two'])
    stubs[1]?.emit(makeSynthSuccess(lastId(stubs[1]!)))
    await p2
    pool.dispose()
  })

  it('fails the slot on a fatal workerError (NotFoundError) and rejects in-flight', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(1, voiceEngine, { createWorker: create })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const p1 = pool.synthesize({ text: 'one', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(1)

    // Fatal MEMFS error forwarded via `workerError` message.
    stubs[0]?.emit({
      type: 'workerError',
      source: 'unhandledrejection',
      message: '/espeak-ng-data not found',
      name: 'NotFoundError',
    })
    await expect(p1).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === 'NotFoundError'
    })

    // Next dispatch respawns.
    const p2 = pool.synthesize({ text: 'two', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(2)
    stubs[1]?.emit(makeSynthSuccess(lastId(stubs[1]!)))
    await p2
    pool.dispose()
  })

  it('does NOT fail the slot on a non-fatal workerError (PARSE_ERROR)', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(1, voiceEngine, { createWorker: create })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const p1 = pool.synthesize({ text: 'one', voiceId: VOICE })
    await flushPosted()

    // Non-fatal PARSE_ERROR — predict typically still succeeds.
    stubs[0]?.emit({
      type: 'workerError',
      source: 'unhandledrejection',
      message: 'PARSE_ERROR: ...',
      name: 'PARSE_ERROR',
    })

    // In-flight request should still resolve when its response arrives.
    stubs[0]?.emit(makeSynthSuccess(lastId(stubs[0]!)))
    await expect(p1).resolves.toMatchObject({ synthMs: 42 })

    // Next dispatch reuses the same worker — no respawn.
    const p2 = pool.synthesize({ text: 'two', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(1)
    stubs[0]?.emit(makeSynthSuccess(lastId(stubs[0]!)))
    await p2
    pool.dispose()
  })

  it('reconstructs a DOMException on error responses with name + code', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(1, voiceEngine, { createWorker: create })

    const pending = pool.synthesize({ text: 'x', voiceId: VOICE })
    await flushPosted()
    stubs[0]?.emit({
      id: lastId(stubs[0]!),
      type: 'error',
      message: 'quota exhausted',
      name: 'QuotaExceededError',
      code: 22,
    })
    await expect(pending).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === 'QuotaExceededError' && err.code === 22
    })
    pool.dispose()
  })

  it('dispose terminates all workers and rejects in-flight', async () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create, stubs } = stubWorkerFactory()
    const pool = new PoolEngine(2, voiceEngine, { createWorker: create })

    const p1 = pool.synthesize({ text: 'one', voiceId: VOICE })
    const p2 = pool.synthesize({ text: 'two', voiceId: VOICE })
    await flushPosted()
    expect(stubs).toHaveLength(2)

    pool.dispose()
    expect(stubs[0]?.terminated).toBe(true)
    expect(stubs[1]?.terminated).toBe(true)
    await expect(p1).rejects.toThrow(/disposed/)
    await expect(p2).rejects.toThrow(/disposed/)
  })

  it('rejects construction with size < 1', () => {
    const voiceEngine = makeVoiceEngineStub()
    const { create } = stubWorkerFactory()
    expect(() => new PoolEngine(0, voiceEngine, { createWorker: create })).toThrow(/size/)
  })
})
