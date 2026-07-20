/**
 * OpenAI-style Server-Sent Events stream parsing for the cloud engine.
 *
 * Streaming chat completions come as a sequence of `data: {…}\\n\\n` events
 * terminated by `data: [DONE]`. Each event's JSON carries
 * `choices[0].delta.content` (an incremental token). {@link parseSseEvent}
 * handles one assembled event; {@link consumeSse} drives a `ReadableStream`,
 * buffering across chunk boundaries and forwarding deltas to a callback.
 */

export interface SseDelta {
  /** Incremental content from this event (may be ''). */
  content: string
  /**
   * Incremental reasoning/thinking text from this event (may be '').
   * Reasoning models (glm-5.2, DeepSeek-R1, OpenAI o1 via OpenRouter,
   * Anthropic thinking) emit prefill+thinking tokens in a separate field
   * before producing visible output. Surfacing these lets the user see
   * the model is "thinking" rather than staring at a hung UI for tens
   * of seconds. Empty for non-reasoning models (gpt-4o, claude-haiku,
   * glm-4.7, etc.) — no regression for the common case.
   */
  reasoning: string
  /** True when the event is the terminal `[DONE]`. */
  done: boolean
}

/**
 * Parse one assembled SSE event (text between blank-line separators) into a
 * delta. Returns `null` for events with no `data:` field (comments, keepalives)
 * or unparseable JSON, so callers can simply skip.
 *
 * Reasoning field name table (per provider):
 * - DeepSeek, z.ai (glm): `delta.reasoning_content`
 * - OpenRouter wrapped: `delta.reasoning`
 * - OpenAI o1 native: withheld (never streamed)
 * - Anthropic: separate content block (different API shape — not handled here)
 */
export function parseSseEvent(event: string): SseDelta | null {
  const dataLines: string[] = []
  for (const line of event.split('\n')) {
    const trimmed = line.replace(/^[\t ]+/, '')
    if (trimmed.startsWith('data:')) {
      // SSE strips exactly one leading space from the field value.
      const value = trimmed.slice(5)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  if (dataLines.length === 0) return null
  const data = dataLines.join('\n')
  if (data === '[DONE]') return { content: '', reasoning: '', done: true }
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_content?: string
          reasoning?: string
        }
      }>
    }
    const delta = parsed.choices?.[0]?.delta
    const content = typeof delta?.content === 'string' ? delta.content : ''
    const reasoningRaw = delta?.reasoning_content ?? delta?.reasoning
    const reasoning = typeof reasoningRaw === 'string' ? reasoningRaw : ''
    return { content, reasoning, done: false }
  } catch {
    return null
  }
}

/**
 * Maximum idle time (ms) between SSE chunks before we declare the stream
 * stalled. Some providers (OpenRouter/Groq/Together) occasionally return 200
 * OK + headers but then never send body chunks — without an idle timeout the
 * reader loop hangs forever, surfacing as "transform stuck at 0%". 45s is
 * forgiving enough for cold-start reasoning models (which can take 10–20s to
 * emit the first token) while still catching genuine hangs in human time.
 */
export const SSE_IDLE_TIMEOUT_MS = 45_000

/**
 * Read an SSE `ReadableStream<Uint8Array>` to completion, invoking `onContent`
 * for each incremental content delta and `onReasoning` (optional) for each
 * reasoning/thinking delta. Normalizes CRLF → LF per decoded chunk. Resolves
 * when the stream ends; rejects with an `AbortError`-like `DOMException` if
 * `signal` aborts mid-stream; rejects with a `TimeoutError` `DOMException` if
 * no bytes arrive within {@link SSE_IDLE_TIMEOUT_MS} (reset on each chunk).
 */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onContent: (delta: string) => void,
  signal?: AbortSignal,
  onReasoning?: (delta: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const rejectIfAborted = (): void => {
    if (signal?.aborted) {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }
  }
  const flushEvent = (event: string): void => {
    const parsed = parseSseEvent(event)
    if (!parsed) return
    if (parsed.content) onContent(parsed.content)
    if (parsed.reasoning) onReasoning?.(parsed.reasoning)
  }

  // Per-read idle timer. The timer is reset on every successful `read()`
  // resolve (including done) so a healthy stream never trips it. If the
  // provider stalls mid-stream, the timer fires and rejects with a clear
  // TimeoutError that the manager's catch surfaces in the banner.
  type ReadResult = Awaited<ReturnType<typeof reader.read>>
  const readWithIdleTimeout = async (): Promise<ReadResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new DOMException(
              `SSE stream stalled — no data received from provider in ${SSE_IDLE_TIMEOUT_MS / 1000}s.`,
              'TimeoutError',
            ),
          ),
        SSE_IDLE_TIMEOUT_MS,
      )
    })
    try {
      return (await Promise.race([reader.read(), timeout])) as ReadResult
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    while (true) {
      rejectIfAborted()
      const { done, value } = await readWithIdleTimeout()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx = buffer.indexOf('\n\n')
      while (idx >= 0) {
        flushEvent(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 2)
        idx = buffer.indexOf('\n\n')
      }
    }
    rejectIfAborted()
    buffer += decoder.decode()
    if (buffer.trim()) flushEvent(buffer)
  } finally {
    reader.releaseLock()
  }
}
