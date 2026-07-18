/**
 * PiperTTS session — vendored rewrite of `@mintplex-labs/piper-tts-web`'s
 * `TtsSession`.
 *
 * Why this exists (the boundary this replaces was the source of the iOS
 * `DomException PARSE_ERROR` symptom):
 *
 * Upstream `predict()` wrapped the WASM in `await new Promise(async (resolve) => {
 *   ...module.callMain(args)... })`. Two properties of that shape were broken:
 *
 * 1. The executor was an `async` function — its rejections are *unhandled* by
 *    the outer Promise (the spec ignores the executor's return value).
 *    Combined with `printErr: (m) => { throw new Error(m) }`, any espeak-ng
 *    stderr line became an unhandled rejection while the outer promise hung.
 * 2. If `_main` threw a C++ exception before writing stdout (e.g.
 *    `nlohmann::json::parse_error` on a lone surrogate in the input), the
 *    outer Promise **never settled** — `resolve` was never called and there
 *    was no `reject` path. The result was an indefinite hang, indistinguishable
 *    from "worker frozen" at the call site. Our 90s synth timeout was the
 *    only thing that recovered.
 *
 * This rewrite drives the WASM as a straight `await` chain, so every failure
 * rejects with a typed `PiperError`. The factory and ORT module are
 * injectable so the boundary is unit-testable without spinning up real WASM.
 *
 * The phonemize step still instantiates a fresh Emscripten module per call
 * (behavior-preserving vs upstream — the module re-mounts the 18 MB
 * espeak-ng-data into MEMFS each time). Reusing a module across calls is a
 * worthwhile optimization but changes global WASM state and is left to a
 * separate spike.
 */

import type { VoiceId } from '../../../../types'
import type { PiperWasmPaths } from '../../wasm-paths'
import { PiperError, type PiperPhase } from './errors'
import { HF_BASE, PATH_MAP } from './models'
import { getBlob } from './opfs'
import { pcm2wav } from './pcm'

/** The Emscripten module shape we actually use from the piper glue. */
export interface PhonemizeModule {
  callMain(args: string[]): number
}

/** Injectable factory for the phonemize WASM module (real = dynamic import of `./glue.js`). */
export type PhonemizeFactory = (opts: {
  print: (data: string) => void
  printErr: (message: string) => void
  locateFile: (url: string) => string
}) => Promise<PhonemizeModule>

/** Subset of `onnxruntime-web` we depend on — injectable for tests. */
export interface OrtModule {
  Tensor: new (type: string, data: unknown, dims?: number[]) => unknown
  InferenceSession: {
    create: (data: ArrayBuffer) => Promise<{
      run: (feeds: Record<string, unknown>) => Promise<{ output: { data: Float32Array } }>
      release: () => Promise<void> | void
    }>
  }
  env: {
    allowLocalModels: boolean
    wasm: { numThreads: number; wasmPaths: string }
  }
}

/** Default phonemize factory: dynamic-imports the vendored glue. */
const defaultPhonemizeFactory: PhonemizeFactory = async (opts) => {
  const { createPiperPhonemize } = await import('./glue.js')
  return (await createPiperPhonemize(opts)) as PhonemizeModule
}

/** Default ORT: dynamic-imports onnxruntime-web (pinned 1.18.0, see AGENTS #1). */
async function defaultOrt(): Promise<OrtModule> {
  return (await import('onnxruntime-web')) as unknown as OrtModule
}

interface ModelConfig {
  espeak: { voice: string }
  audio: { sample_rate: number }
  inference: { noise_scale: number; length_scale: number; noise_w: number }
  speaker_id_map: Record<string, unknown>
}

export interface PiperSessionOptions {
  voiceId: VoiceId
  wasmPaths: PiperWasmPaths
  onProgress?: (p: { url: string; loaded: number; total: number }) => void
  /** Test-only: inject a mock phonemize factory. */
  createPhonemize?: PhonemizeFactory
  /** Test-only: inject a mock ORT module. */
  ort?: OrtModule
}

/**
 * One Piper session = one loaded voice model + a bound ORT inference session.
 * Predict re-instantiates the phonemize WASM per call (matches upstream).
 *
 * `create()` is the only constructor path — it ensures the model is loaded
 * before the session is returned.
 */
export class PiperSession {
  private readonly voiceId: VoiceId
  private readonly wasmPaths: PiperWasmPaths
  private readonly createPhonemize: PhonemizeFactory
  private readonly ort: OrtModule
  private readonly config: ModelConfig
  private ortSession: {
    run: (feeds: Record<string, unknown>) => Promise<{ output: { data: Float32Array } }>
    release: () => Promise<void> | void
  } | null = null
  /** Serializes predict calls — defensive (each call spins a fresh module anyway). */
  private predictChain: Promise<unknown> = Promise.resolve()

  private constructor(opts: PiperSessionOptions & { config: ModelConfig; ort: OrtModule }) {
    this.voiceId = opts.voiceId
    this.wasmPaths = opts.wasmPaths
    this.createPhonemize = opts.createPhonemize ?? defaultPhonemizeFactory
    this.ort = opts.ort
    this.config = opts.config
  }

  static async create(opts: PiperSessionOptions): Promise<PiperSession> {
    const ort = opts.ort ?? (await defaultOrt())
    ort.env.allowLocalModels = false
    ort.env.wasm.numThreads = navigator.hardwareConcurrency
    ort.env.wasm.wasmPaths = opts.wasmPaths.onnxWasm

    const path = PATH_MAP[opts.voiceId]
    if (!path) {
      throw new PiperError({
        phase: 'model-load',
        voiceId: opts.voiceId,
        textLength: 0,
        message: `unknown voiceId (not in PATH_MAP)`,
      })
    }

    let config: ModelConfig
    let modelBuffer: ArrayBuffer
    try {
      const configBlob = await getBlob(`${HF_BASE}/${path}.json`, opts.onProgress)
      config = JSON.parse(await configBlob.text()) as ModelConfig
      const modelBlob = await getBlob(`${HF_BASE}/${path}`, opts.onProgress)
      modelBuffer = await modelBlob.arrayBuffer()
    } catch (e) {
      throw new PiperError({
        phase: 'model-load',
        voiceId: opts.voiceId,
        textLength: 0,
        message: e instanceof Error ? e.message : String(e),
        cause: e,
      })
    }

    let ortSession: {
      run: (feeds: Record<string, unknown>) => Promise<{ output: { data: Float32Array } }>
      release: () => Promise<void> | void
    }
    try {
      ortSession = await ort.InferenceSession.create(modelBuffer)
    } catch (e) {
      throw new PiperError({
        phase: 'model-load',
        voiceId: opts.voiceId,
        textLength: 0,
        message: `ORT InferenceSession.create failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      })
    }

    return new PiperSession({ ...opts, config, ort }).withOrtSession(ortSession)
  }

  /** Test affordance — keep off the public constructor. */
  private withOrtSession(ortSession: NonNullable<PiperSession['ortSession']>): this {
    this.ortSession = ortSession
    return this
  }

  /**
   * Phonemize + synthesize one chunk of text. The input **must** already be
   * sanitized (see `normalizeForSpeech` — lone surrogates in particular will
   * trip `nlohmann::json::parse_error` inside the WASM and we want them
   * stripped before they reach this boundary).
   *
   * Rejects with `PiperError` on any failure:
   *   - `phase:'phonemize'` → bad input or espeak-ng stderr / non-zero exit
   *   - `phase:'inference'` → ORT `.run()` threw
   *   - `phase:'audio'`     → WAV encode failed (shouldn't happen in practice)
   */
  predict(text: string): Promise<Blob> {
    const run = () => this.predictOnce(text)
    // Chain so concurrent callers don't race MEMFS state inside the WASM.
    const result = this.predictChain.then(run, run)
    this.predictChain = result.catch(() => {})
    return result as Promise<Blob>
  }

  private async predictOnce(text: string): Promise<Blob> {
    const input = JSON.stringify([{ text }])
    const stderr: string[] = []
    let stdoutLine: string | null = null

    const module = await this.createPhonemize({
      print: (data: string) => {
        stdoutLine = data
      },
      printErr: (message: string) => {
        stderr.push(message)
      },
      locateFile: (url: string) => {
        if (url.endsWith('.wasm')) return this.wasmPaths.piperWasm
        if (url.endsWith('.data')) return this.wasmPaths.piperData
        return url
      },
    })

    let exitCode: number | undefined
    let thrown: unknown
    try {
      exitCode = module.callMain([
        '-l',
        this.config.espeak.voice,
        '--input',
        input,
        '--espeak_data',
        '/espeak-ng-data',
      ])
    } catch (e) {
      thrown = e
    }

    // The four failure modes:
    //   (a) callMain threw           → C++ exception (nlohmann parse_error,
    //                                  espeak runtime_error, abort, …).
    //   (b) no stdout                → main died before emitting phoneme_ids.
    //   (c) stdout not valid JSON    → glue/ESM oddity, treat as phonemize failure.
    //   (d) exitCode != 0            → explicit non-zero return.
    // Any of these becomes a typed PiperError instead of a hang.
    if (thrown || stdoutLine === null || (exitCode !== undefined && exitCode !== 0)) {
      const reason =
        thrown instanceof Error
          ? `${thrown.name}: ${thrown.message}`
          : thrown !== undefined
            ? `wasm threw ${String(thrown)}`
            : stdoutLine === null
              ? 'no phoneme output (main aborted before stdout)'
              : `non-zero exit`
      throw new PiperError({
        phase: 'phonemize',
        voiceId: this.voiceId,
        textLength: text.length,
        message: reason,
        ...(stderr.length ? { stderr } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(thrown !== undefined ? { cause: thrown } : {}),
      })
    }

    let phonemeIds: number[]
    try {
      phonemeIds = (JSON.parse(stdoutLine).phoneme_ids ?? []) as number[]
    } catch (e) {
      throw new PiperError({
        phase: 'phonemize',
        voiceId: this.voiceId,
        textLength: text.length,
        message: `stdout JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
        stderr,
        exitCode,
        cause: stdoutLine ?? undefined,
      })
    }

    if (!this.ortSession) {
      throw new PiperError({
        phase: 'inference',
        voiceId: this.voiceId,
        textLength: text.length,
        message: 'ORT session missing (session disposed?)',
      })
    }

    const feeds: Record<string, unknown> = {
      input: new this.ort.Tensor('int64', BigInt64Array.from(phonemeIds.map(BigInt)), [
        1,
        phonemeIds.length,
      ]),
      input_lengths: new this.ort.Tensor('int64', BigInt64Array.from([BigInt(phonemeIds.length)])),
      scales: new this.ort.Tensor(
        'float32',
        new Float32Array([
          this.config.inference.noise_scale,
          this.config.inference.length_scale,
          this.config.inference.noise_w,
        ]),
      ),
    }
    if (Object.keys(this.config.speaker_id_map).length) {
      feeds.sid = new this.ort.Tensor('int64', BigInt64Array.from([0n]))
    }

    let pcm: Float32Array
    try {
      const out = await this.ortSession.run(feeds)
      pcm = out.output.data
    } catch (e) {
      throw new PiperError({
        phase: 'inference',
        voiceId: this.voiceId,
        textLength: text.length,
        message: e instanceof Error ? e.message : String(e),
        cause: e,
      })
    }

    try {
      const wav = pcm2wav(pcm, 1, this.config.audio.sample_rate)
      return new Blob([wav], { type: 'audio/x-wav' })
    } catch (e) {
      throw new PiperError({
        phase: 'audio',
        voiceId: this.voiceId,
        textLength: text.length,
        message: e instanceof Error ? e.message : String(e),
        cause: e,
      })
    }
  }

  /** Release the ORT session. The phonemize module is GC'd between calls. */
  async dispose(): Promise<void> {
    const session = this.ortSession
    this.ortSession = null
    if (session) {
      try {
        await session.release()
      } catch {
        // Best-effort — disposing must never throw.
      }
    }
  }
}

/** Re-export the phase type for callers that switch on `PiperError.phase`. */
export type { PiperPhase }
