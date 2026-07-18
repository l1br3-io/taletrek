import type { BookId, VoiceId } from '../../types'

export type TtsRequest =
  | {
      id: number
      op: 'synthesize'
      text: string
      voiceId: VoiceId
      bookId?: BookId
      returnAudio?: boolean
    }
  | { id: number; op: 'download'; voiceId: VoiceId }
  | { id: number; op: 'isStored'; voiceId: VoiceId }
  | { id: number; op: 'remove'; voiceId: VoiceId }
  | { id: number; op: 'clearAllStored' }
  /**
   * Drop the cached Piper session (model + WASM state + Emscripten MEMFS) so
   * the next op re-creates it from scratch. Triggered by the main thread
   * after a fatal worker-level error (e.g. `NotFoundError` from Emscripten
   * MEMFS — the espeak-ng-data disappeared from the virtual FS, leaving the
   * session in a permanently broken state where every predict silently
   * fails). Recycling is the only recovery path: the WASM module's MEMFS
   * can't be repaired in place, only rebuilt by re-running `init()`.
   */
  | { id: number; op: 'resetEngine' }

export type TtsResponse =
  | { id: number; type: 'progress'; fraction: number }
  | {
      id: number
      type: 'success'
      op: 'synthesize'
      audio?: Blob
      synthMs: number
      durationSeconds: number
      cacheKey: string
    }
  | { id: number; type: 'success'; op: 'isStored'; stored: boolean }
  | { id: number; type: 'success'; op: 'download' }
  | { id: number; type: 'success'; op: 'remove' }
  | { id: number; type: 'success'; op: 'clearAllStored' }
  | { id: number; type: 'success'; op: 'resetEngine' }
  | { id: number; type: 'error'; message: string; name?: string; code?: number }
  /**
   * Worker-level error — not correlated to a specific request. Emitted by the
   * worker's `error` / `unhandledrejection` listeners when something escapes
   * `ctx.onmessage`'s try/catch (e.g. Piper's Emscripten `printErr` callback
   * throws across the WASM boundary, which surfaces as an unhandled rejection
   * rather than a predict failure). Forwarded to the main thread so vConsole
   * on iOS can attribute these — without this they show up as anonymous
   * `DomException PARSE_ERROR` logs with no source context.
   */
  | {
      type: 'workerError'
      source: 'error' | 'unhandledrejection'
      message: string
      name?: string
      code?: number
      filename?: string
      lineno?: number
      colno?: number
      stack?: string
    }

/** A success response of any op — the resolved payload from `request`. */
export type TtsSuccess = Extract<TtsResponse, { type: 'success' }>
/** A request without its correlation `id` — distributes over the union so the
 *  `op` discriminator stays usable when constructing a request body. */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type TtsRequestBody = WithoutId<TtsRequest>
