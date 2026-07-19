import { formatError } from '../format-error'
import type { TtsRequest, TtsResponse, TtsSuccess } from './protocol'
import type { SynthesisRequest, SynthesisResult, TtsEngine, Voice } from './types'
import { CURATED_VOICES } from './voices'

/**
 * Same fatal-error allowlist as `TtsClient` (`client.ts`). When a worker-level
 * error fires with one of these names, the worker's PiperSession is in a
 * permanently broken state — we mark the slot failed, terminate the worker,
 * and re-spawn on the next dispatch (mirrors the singleton client's
 * `resetEngine` recovery, just at the worker level instead of in-place).
 */
const FATAL_WORKER_ERROR_NAMES = new Set([
  'NotFoundError', // Emscripten MEMFS: /espeak-ng-data disappeared
  'InvalidStateError', // WASM module in an invalid state (post-crash)
  'DataError', // model tensor data unparseable
  'InternalError', // WASM trap / unreachable
])

/** Worker slot — tracks pending count + failure state. */
interface Slot {
  worker: Worker
  pending: number
  /**
   * Set when a fatal error fires on this slot. The next `acquireSlot` that
   * would target this slot instead re-spawns it (terminate + replace).
   */
  failed: boolean
}

export interface PoolEngineOptions {
  /**
   * Factory for the underlying Piper worker. Defaults to the real
   * `tts.worker.ts`; tests inject a stub.
   */
  createWorker?: () => Worker
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL('../../workers/tts.worker.ts', import.meta.url), {
    type: 'module',
  })
}

function makeWorkerError(msg: Extract<TtsResponse, { type: 'error' }>): Error {
  if (msg.name) {
    try {
      return new DOMException(msg.message, msg.name)
    } catch {
      // DOMException name validation can throw on unknown names — fall through.
    }
  }
  return new Error(msg.message)
}

/**
 * Parallel-synthesis engine (ADR-0011): a pool of Piper TTS workers, lazily
 * spun up to `size` and dispatched least-busy.
 *
 * ## Why a pool, not ORT threads
 * The Piper spike (M2) rejected COOP/COEP headers (any-static-host goal), so
 * `ort.env.wasm.numThreads` is effectively a no-op in production. The only
 * practical parallel axis is multiple Worker realms, each with its own resident
 * ORT session + phonemize module. The in-worker `predictChain` (`session.ts`)
 * already serialises calls inside one PiperSession — but each *worker* has its
 * own session, so two workers truly run in parallel.
 *
 * ## Why lazy spin-up
 * Each worker pays ~4s for `InferenceSession.create` on first use and ~63 MB
 * resident model memory. Spinning all N eagerly would spike memory at t=0 for
 * no gain — the second worker isn't needed until the first has a pending
 * synth. Lazy growth = the first N dispatches pay the cold load concurrently,
 * and idle workers never spawn.
 *
 * ## Why least-busy dispatch
 * Cache hits (`synthMs === 0`) return near-instantly; round-robin would queue
 * behind a long-running synth needlessly. Least-busy absorbs the variance and
 * keeps the window full.
 *
 * ## API surface
 * `synthesize` is the only pool-backed op. Voice management (`listVoices`,
 * `isStored`, `download`, `remove`, `clearAllStored`) delegates to the
 * `voiceEngine` passed at construction — typically the singleton `ttsClient`.
 * Pool workers never download voices themselves; each lazy-spawned worker's
 * `PiperEngine` loads the model from OPFS on first synth, and the upload
 * pipeline pre-downloads the voice via the singleton before pre-synth starts.
 *
 * ## Concurrency hint
 * `concurrency` exposes the pool size so `preSynthesizeBook` can match its
 * dispatch window to the number of workers — one in-flight synth per worker
 * keeps the pool saturated without over-dispatching.
 */
export class PoolEngine implements TtsEngine {
  private readonly slots: Slot[] = []
  private nextId = 1
  private readonly pending = new Map<
    number,
    {
      resolve: (v: TtsSuccess) => void
      reject: (e: Error) => void
      slotIdx: number
    }
  >()
  private readonly createWorkerImpl: () => Worker

  constructor(
    /** Max parallel workers. Read by callers (e.g. pre-synth) to size their dispatch window. */
    readonly concurrency: number,
    /** Engine used for voice-management ops (not synth). */
    private readonly voiceEngine: TtsEngine,
    opts: PoolEngineOptions = {},
  ) {
    if (concurrency < 1) throw new Error('PoolEngine size must be ≥ 1')
    this.createWorkerImpl = opts.createWorker ?? defaultCreateWorker
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const t0 = performance.now()
    const id = this.nextId++
    const slotIdx = this.acquireSlot()
    const slot = this.slots[slotIdx]!
    slot.pending++
    console.log('[taletrek] tts pool: synthesize request', {
      id,
      slotIdx,
      textLen: req.text.length,
      voiceId: req.voiceId,
      returnAudio: req.returnAudio,
      ...(req.bookId !== undefined ? { bookId: req.bookId } : {}),
    })
    try {
      const res = await new Promise<TtsSuccess>((resolve, reject) => {
        this.pending.set(id, { resolve, reject, slotIdx })
        const ttsReq: TtsRequest = {
          id,
          op: 'synthesize',
          text: req.text,
          voiceId: req.voiceId,
          returnAudio: req.returnAudio,
          ...(req.bookId !== undefined ? { bookId: req.bookId } : {}),
        }
        slot.worker.postMessage(ttsReq)
      })
      if (res.op !== 'synthesize') {
        throw new Error(`unexpected response op: ${res.op}`)
      }
      console.log('[taletrek] tts pool: synthesize response', {
        id,
        slotIdx,
        textLen: req.text.length,
        elapsedMs: Math.round(performance.now() - t0),
      })
      return {
        audio: res.audio,
        synthMs: res.synthMs,
        durationSeconds: res.durationSeconds,
        cacheKey: res.cacheKey,
      }
    } catch (err) {
      console.error('[taletrek] tts pool: synthesize rejected', {
        id,
        slotIdx,
        textLen: req.text.length,
        elapsedMs: Math.round(performance.now() - t0),
        errName: (err as Error).name,
        errCode: (err as DOMException).code,
        errConstructor: (err as object).constructor?.name,
        errMessage: (err as Error).message,
      })
      throw err
    }
  }

  // ── Voice management delegates to the singleton voiceEngine ──────────────
  // Pool workers lazy-load their own model from OPFS on first synth (already
  // populated by the upload pipeline's pre-synth voice download via the
  // singleton); the pool itself never coordinates downloads.

  async listVoices(): Promise<Voice[]> {
    return this.voiceEngine.listVoices()
  }
  async isStored(voiceId: Parameters<TtsEngine['isStored']>[0]): Promise<boolean> {
    return this.voiceEngine.isStored(voiceId)
  }
  async download(
    voiceId: Parameters<TtsEngine['download']>[0],
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    return this.voiceEngine.download(voiceId, onProgress)
  }
  async remove(voiceId: Parameters<TtsEngine['remove']>[0]): Promise<void> {
    return this.voiceEngine.remove(voiceId)
  }
  async clearAllStored(): Promise<void> {
    return this.voiceEngine.clearAllStored()
  }

  /**
   * Terminate every worker, reject all in-flight. Used by tests and a future
   * "Stop synthesis" UI action. After `dispose()`, the pool is no longer
   * usable — constructing a fresh `PoolEngine` is the recovery path.
   */
  dispose(): void {
    for (const slot of this.slots) {
      try {
        slot.worker.terminate()
      } catch {
        // Termination is best-effort during teardown.
      }
    }
    this.slots.length = 0
    const err = new Error('tts pool disposed')
    for (const [, entry] of this.pending) {
      entry.reject(err)
    }
    this.pending.clear()
  }

  // ── Internal dispatch + lifecycle ─────────────────────────────────────────

  /**
   * Pick a slot for the next dispatch. Grows the pool lazily up to `size`,
   * picks least-busy among healthy slots, and re-spawns a failed slot when
   * every existing slot is failed (rare "all workers OOM'd" recovery).
   */
  private acquireSlot(): number {
    const canGrow = this.slots.length < this.concurrency
    const hasHealthyIdle = this.slots.some((s) => !s.failed && s.pending === 0)
    if (canGrow && !hasHealthyIdle) {
      return this.spawnSlot()
    }

    let bestIdx = -1
    let bestPending = Infinity
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!
      if (s.failed) continue
      if (s.pending < bestPending) {
        bestPending = s.pending
        bestIdx = i
      }
    }
    if (bestIdx === -1) {
      // Every existing slot is failed and we're at cap — re-spawn the first
      // failed slot. (If we were under cap, the `canGrow && !hasHealthyIdle`
      // branch above would have already spawned.)
      return this.respawnFirstFailed()
    }
    return bestIdx
  }

  private spawnSlot(): number {
    const idx = this.slots.length
    const worker = this.createWorkerImpl()
    const slot: Slot = { worker, pending: 0, failed: false }
    this.attachHandlers(idx, slot)
    this.slots.push(slot)
    console.log('[taletrek] tts pool: spawned worker', {
      idx,
      total: this.slots.length,
      cap: this.concurrency,
    })
    return idx
  }

  private respawnFirstFailed(): number {
    const idx = this.slots.findIndex((s) => s.failed)
    if (idx === -1) {
      // Should be impossible given acquireSlot's logic; defend.
      throw new Error('tts pool: no slot available and none to respawn')
    }
    const old = this.slots[idx]!
    // Already terminated in failSlot — terminate again defensively (idempotent).
    try {
      old.worker.terminate()
    } catch {
      // Ignore.
    }
    const worker = this.createWorkerImpl()
    const slot: Slot = { worker, pending: 0, failed: false }
    this.attachHandlers(idx, slot)
    this.slots[idx] = slot
    console.warn('[taletrek] tts pool: respawned failed worker', { idx })
    return idx
  }

  private attachHandlers(slotIdx: number, slot: Slot): void {
    slot.worker.addEventListener('error', (e: ErrorEvent) => {
      console.error('[taletrek] tts pool: worker crashed', {
        slotIdx,
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
        error: formatError(e.error),
        pending: slot.pending,
      })
      this.failSlot(
        slotIdx,
        new Error(`tts worker ${slotIdx} crashed: ${e.message || 'unknown error'}`),
      )
    })
    slot.worker.addEventListener('messageerror', () => {
      console.error('[taletrek] tts pool: worker message error', { slotIdx, pending: slot.pending })
      this.failSlot(slotIdx, new Error(`tts worker ${slotIdx} message error`))
    })
    slot.worker.addEventListener('message', (event: MessageEvent<TtsResponse>) => {
      this.handleMessage(slotIdx, event.data)
    })
  }

  /**
   * Mark a slot permanently broken: terminate the worker and reject every
   * in-flight request on this slot. The next `acquireSlot` will re-spawn it.
   */
  private failSlot(slotIdx: number, reason: Error): void {
    const slot = this.slots[slotIdx]
    if (!slot || slot.failed) return
    slot.failed = true
    try {
      slot.worker.terminate()
    } catch {
      // Termination is best-effort.
    }
    // Reject every in-flight request on this slot — they're lost when the
    // worker dies. (Piper predict is uninterruptible; if it was mid-call, the
    // result is gone with the worker.)
    for (const [id, entry] of this.pending) {
      if (entry.slotIdx !== slotIdx) continue
      this.pending.delete(id)
      entry.reject(reason)
    }
    slot.pending = 0
  }

  private handleMessage(slotIdx: number, msg: TtsResponse): void {
    const slot = this.slots[slotIdx]
    if (!slot) return

    if (msg.type === 'workerError') {
      // Worker-level error forwarded from the worker's error/unhandledrejection
      // listeners (see tts.worker.ts). Logged loudly so vConsole on iOS
      // surfaces it; NOT fatal by default — predict typically still succeeds
      // despite PARSE_ERROR noise (matches singleton client.ts semantics).
      console.error('[taletrek] tts pool: worker-level error forwarded', {
        slotIdx,
        source: msg.source,
        name: msg.name,
        code: msg.code,
        message: msg.message,
        filename: msg.filename,
        lineno: msg.lineno,
        pending: slot.pending,
      })
      if (msg.name && FATAL_WORKER_ERROR_NAMES.has(msg.name)) {
        console.error(
          `[taletrek] tts pool: fatal worker error on slot ${slotIdx} — will respawn on next dispatch`,
          { name: msg.name },
        )
        this.failSlot(
          slotIdx,
          msg.name ? new DOMException(msg.message, msg.name) : new Error(msg.message),
        )
      }
      return
    }

    const entry = this.pending.get(msg.id)
    if (!entry) return
    if (msg.type === 'progress') {
      // Pre-synth uses returnAudio:false and ignores progress (it's a batch
      // synth, not a UI-visible per-¶ progress event). Voice-download progress
      // goes through the singleton voiceEngine, not the pool.
      return
    }

    // Terminal response (success or error) — decrement pending for the slot
    // and resolve/reject the waiting caller.
    slot.pending = Math.max(0, slot.pending - 1)
    this.pending.delete(msg.id)
    if (msg.type === 'success') {
      entry.resolve(msg)
    } else {
      entry.reject(makeWorkerError(msg))
    }
  }
}

/**
 * Test-only escape hatch: clear the curated voices cache reference. Present
 * only so the export surface mirrors `TtsClient` (no module-level state to
 * reset in PoolEngine — instances are independent).
 */
export function _resetPoolForTests(): void {
  // No-op — PoolEngine state is per-instance.
  void CURATED_VOICES
}
