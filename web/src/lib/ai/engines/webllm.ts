import type { AppConfig, InitProgressReport, MLCEngineInterface } from '@mlc-ai/web-llm'

import { type CompleteFn, runHints, runTransform } from '../runner'
import type { AiTransformEngine, PronunciationCandidate, TransformOp } from '../types'
import { hasWebGpu } from '../webgpu'

export interface WebLlmConfig {
  modelId: string
  /** Idle grace period before the model is unloaded + worker torn down. */
  idleMs?: number
}

/** Typed error from the in-browser engine. */
export class WebLlmError extends Error {
  constructor(
    public readonly code: 'no-webgpu' | 'not-loaded' | 'load-failed',
    message: string,
  ) {
    super(message)
    this.name = 'WebLlmError'
  }
}

const DEFAULT_IDLE_MS = 5 * 60 * 1000

/**
 * In-browser `AiTransformEngine` — WebGPU via WebLLM, running in a dedicated
 * worker. Model is cached in OPFS (`cacheBackend: 'opfs'`) and stays resident
 * until `idleMs` of inactivity, after which it is unloaded and the worker torn
 * down (mirrors the Piper `tts/client.ts` singleton-ish lifecycle).
 *
 * `@mlc-ai/web-llm` is **lazy-imported** in {@link load} (mirrors the
 * `pdfjs-dist` pattern, gotcha #7) so the heavy runtime is never pulled into
 * the main bundle or loaded in jsdom — only when a reader actually enables the
 * in-browser backend.
 */
export class WebLlmEngine implements AiTransformEngine {
  private engine: MLCEngineInterface | null = null
  private worker: Worker | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly idleMs: number

  constructor(private readonly config: WebLlmConfig) {
    this.idleMs = config.idleMs ?? DEFAULT_IDLE_MS
  }

  async isReady(): Promise<boolean> {
    if (!(await hasWebGpu())) return false
    return this.engine !== null
  }

  /** Download (or rehydrate from OPFS) + load the model. Idempotent. */
  async load(onLoadProgress?: (fraction: number) => void): Promise<void> {
    if (this.engine) return
    if (!(await hasWebGpu())) {
      throw new WebLlmError(
        'no-webgpu',
        'WebGPU is unavailable in this browser. Use the cloud backend, or run on a Vulkan-capable browser.',
      )
    }
    const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import('@mlc-ai/web-llm')
    const appConfig: AppConfig = { ...prebuiltAppConfig, cacheBackend: 'opfs' }
    this.worker = new Worker(new URL('../webllm.worker.ts', import.meta.url), {
      type: 'module',
    })
    const initProgressCallback = (r: InitProgressReport) => onLoadProgress?.(r.progress)
    try {
      this.engine = await CreateWebWorkerMLCEngine(this.worker, this.config.modelId, {
        initProgressCallback,
        appConfig,
      })
    } catch (e) {
      await this.teardown()
      throw new WebLlmError('load-failed', `Failed to load model: ${(e as Error).message}`)
    }
    this.scheduleIdleTeardown()
  }

  async transform(
    input: string[],
    op: TransformOp,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<string[]> {
    this.requireLoaded()
    return runTransform(input, op, this.complete, onProgress, signal)
  }

  async proposePronunciationHints(
    sample: string[],
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<PronunciationCandidate[]> {
    this.requireLoaded()
    return runHints(sample, this.complete, onProgress, signal)
  }

  /** Unload the model and terminate the worker, reclaiming GPU memory. */
  async teardown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    try {
      await this.engine?.unload()
    } catch {
      /* already torn down */
    }
    this.engine = null
    this.worker?.terminate()
    this.worker = null
  }

  /** Bound completion primitive passed to the shared runner. */
  private complete: CompleteFn = async (messages, opts = {}) => {
    if (!this.engine) throw new WebLlmError('not-loaded', 'Model not loaded — call load() first.')
    const engine = this.engine
    // WebLLM has no AbortSignal on create() (spike finding #6); bridge it to
    // interruptGenerate(). A pre-aborted signal interrupts + rejects immediately.
    if (opts.signal?.aborted) {
      void engine.interruptGenerate()
      throw new DOMException('The user aborted a request.', 'AbortError')
    }
    const onAbort = (): void => {
      void engine.interruptGenerate()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const stream = await engine.chat.completions.create({
        messages: [
          { role: 'system' as const, content: messages.system },
          { role: 'user' as const, content: messages.user },
        ],
        temperature: 0.3,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
      })
      let acc = ''
      for await (const chunk of stream) {
        acc += chunk.choices[0]?.delta?.content ?? ''
      }
      return acc.trim()
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      this.scheduleIdleTeardown()
    }
  }

  private requireLoaded(): void {
    if (!this.engine) {
      throw new WebLlmError('not-loaded', 'Model not loaded — call load() first.')
    }
  }

  private scheduleIdleTeardown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.teardown().catch(() => {})
    }, this.idleMs)
  }
}
