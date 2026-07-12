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
  /** True when the event is the terminal `[DONE]`. */
  done: boolean
}

/**
 * Parse one assembled SSE event (text between blank-line separators) into a
 * delta. Returns `null` for events with no `data:` field (comments, keepalives)
 * or unparseable JSON, so callers can simply skip.
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
  if (data === '[DONE]') return { content: '', done: true }
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string } }>
    }
    const delta = parsed.choices?.[0]?.delta?.content
    return { content: typeof delta === 'string' ? delta : '', done: false }
  } catch {
    return null
  }
}

/**
 * Read an SSE `ReadableStream<Uint8Array>` to completion, invoking `onContent`
 * for each incremental delta. Normalizes CRLF → LF per decoded chunk. Resolves
 * when the stream ends or `[DONE]` is seen; rejects with an `AbortError`-like
 * `DOMException` if `signal` aborts mid-stream.
 */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onContent: (delta: string) => void,
  signal?: AbortSignal,
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
    if (parsed?.content) onContent(parsed.content)
  }
  try {
    while (true) {
      rejectIfAborted()
      const { done, value } = await reader.read()
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
