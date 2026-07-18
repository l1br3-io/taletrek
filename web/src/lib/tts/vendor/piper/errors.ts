/**
 * Error taxonomy for the vendored piper boundary.
 *
 * The upstream wrapper's `predict()` had no error contract: any failure
 * inside the WASM (a thrown C++ exception, a missing MEMFS file, an ORT
 * inference error) became either an unhandled rejection or a promise that
 * never settled — both indistinguishable from "frozen" at the call site.
 *
 * `PiperError` tags the failure phase so the engine/UI can react
 * appropriately (e.g. `phonemize` failures point at the input text;
 * `model-load` failures point at storage/network). All fields are
 * primitives so the object serializes cleanly through `postMessage` and
 * vConsole — no getters that could trigger vConsole's `(PARSE_ERROR)`
 * placeholder.
 */

export type PiperPhase = 'model-load' | 'phonemize' | 'inference' | 'audio'

export interface PiperErrorInit {
  phase: PiperPhase
  voiceId: string
  /** Length of the (already normalized) input text — never the text itself. */
  textLength: number
  message: string
  /** espeak-ng / nlohmann stderr lines captured from the WASM, if any. */
  stderr?: string[]
  /** WASM `callMain` exit code, when this came from the phonemize step. */
  exitCode?: number
  cause?: unknown
}

export class PiperError extends Error {
  readonly phase: PiperPhase
  readonly voiceId: string
  readonly textLength: number
  readonly stderr: string[]
  readonly exitCode: number | undefined
  override readonly cause: unknown

  constructor(init: PiperErrorInit) {
    const stderrTag = init.stderr?.length ? ` stderr[${init.stderr.length}]` : ''
    const exitTag = init.exitCode !== undefined ? ` exit=${init.exitCode}` : ''
    super(`${init.phase}: ${init.message}${exitTag}${stderrTag}`)
    this.name = 'PiperError'
    this.phase = init.phase
    this.voiceId = init.voiceId
    this.textLength = init.textLength
    this.stderr = init.stderr ?? []
    this.exitCode = init.exitCode
    this.cause = init.cause
  }

  /**
   * Plain-data view for `postMessage` / `JSON.stringify` / vConsole — drops
   * the `cause` (which may not be structured-cloneable) and keeps everything
   * else as primitives.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      phase: this.phase,
      voiceId: this.voiceId,
      textLength: this.textLength,
      message: this.message,
      stderr: this.stderr,
      exitCode: this.exitCode,
    }
  }
}
