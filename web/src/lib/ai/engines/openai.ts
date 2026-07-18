import { getApiKey } from '../keyring'
import type { CompletionMessages } from '../prompts'
import { runHints, runOutlineDetection, runTransform } from '../runner'
import type {
  AiOutlineChapter,
  AiTransformEngine,
  PronunciationCandidate,
  TransformDefinition,
  TransformOp,
} from '../types'
import { consumeSse } from './sse'

export interface CloudConfig {
  providerId: string
  baseUrl: string
  model: string
  /** Provider's context window size in tokens (used for chunk computation). */
  contextLimit: number
}

/** Typed error from the cloud engine. `status` is the HTTP code (or 401/0 for pre-request failures). */
export class CloudError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'CloudError'
  }
}

interface CompleteOptions {
  json?: boolean
  signal?: AbortSignal
  /** Live per-token callback: receives accumulated text + the new delta. */
  onDelta?: (textSoFar: string, delta: string) => void
}

/**
 * Cloud `AiTransformEngine` — OpenAI-compatible Chat Completions over native
 * `fetch`. One `{baseUrl, apiKey, model}` config covers OpenAI, Anthropic's
 * OpenAI-compat shim, OpenRouter, Groq, Together, Ollama, LM Studio.
 *
 * The key never leaves the `keyring` module except into the `Authorization`
 * header of an allowlisted request (see `docs/adr/0004-api-key-threat-model.md`).
 * Runs on the main thread — `fetch` + SSE parsing is non-blocking; no CPU work.
 * Chunking, reassembly, and progress are delegated to the shared `runner`.
 */
export class CloudLlmEngine implements AiTransformEngine {
  constructor(private readonly config: CloudConfig) {}

  async isReady(): Promise<boolean> {
    return !!getApiKey(this.config.providerId) && !!this.config.baseUrl && !!this.config.model
  }

  async transform(
    input: string[],
    op: TransformOp,
    def: TransformDefinition,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
    onDelta?: (textSoFar: string, delta: string) => void,
  ): Promise<string[]> {
    this.requireKey()
    return runTransform(
      input,
      def,
      op.params,
      this.config.contextLimit,
      this.complete,
      onProgress,
      signal,
      onDelta,
    )
  }

  async proposePronunciationHints(
    sample: string[],
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<PronunciationCandidate[]> {
    this.requireKey()
    return runHints(sample, this.complete, onProgress, signal)
  }

  async detectOutline(
    paragraphs: string[],
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<AiOutlineChapter[]> {
    this.requireKey()
    return runOutlineDetection(paragraphs, this.complete, onProgress, signal)
  }

  private requireKey(): void {
    if (!getApiKey(this.config.providerId)) {
      throw new CloudError(401, 'No API key set — open Settings → AI and enter your key.')
    }
  }

  private complete = async (
    messages: CompletionMessages,
    opts: CompleteOptions = {},
  ): Promise<string> => {
    const key = getApiKey(this.config.providerId)
    if (!key) {
      throw new CloudError(401, 'No API key set — open Settings → AI and enter your key.')
    }
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body = {
      model: this.config.model,
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      temperature: 0.3,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new CloudError(res.status, `${res.status} ${res.statusText}${text ? `: ${text}` : ''}`)
    }
    if (!res.body) {
      throw new CloudError(res.status, 'Empty response body from provider.')
    }
    let acc = ''
    await consumeSse(
      res.body,
      (delta) => {
        acc += delta
        opts.onDelta?.(acc, delta)
      },
      opts.signal,
    )
    return acc.trim()
  }
}
