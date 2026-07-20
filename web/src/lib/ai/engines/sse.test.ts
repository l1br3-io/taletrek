import { describe, expect, it, vi } from 'vitest'
import { consumeSse, parseSseEvent, SSE_IDLE_TIMEOUT_MS } from './sse'

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p))
      controller.close()
    },
  })
}

function delta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`
}

/** Builds an SSE event carrying a `reasoning_content` delta (DeepSeek/z.ai style). */
function reasoningDelta(reasoning: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] })}\n\n`
}

/** Builds an SSE event carrying a `reasoning` delta (OpenRouter wrapped style). */
function reasoningDeltaAlt(reasoning: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning } }] })}\n\n`
}

const DONE = 'data: [DONE]\n\n'

describe('parseSseEvent', () => {
  it('extracts the delta content from a data event', () => {
    expect(parseSseEvent(delta('hi'))).toEqual({ content: 'hi', reasoning: '', done: false })
  })

  it('flags the terminal [DONE] event', () => {
    expect(parseSseEvent(DONE)).toEqual({ content: '', reasoning: '', done: true })
  })

  it('returns null for an event with no data line', () => {
    expect(parseSseEvent(': keepalive\n\n')).toBeNull()
    expect(parseSseEvent('event: ping\nid: 1\n\n')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseSseEvent('data: {not json\n\n')).toBeNull()
  })

  it('accepts a data field without a leading space', () => {
    expect(parseSseEvent('data:{"choices":[{"delta":{"content":"x"}}]}\n\n')).toEqual({
      content: 'x',
      reasoning: '',
      done: false,
    })
  })

  it('concatenates multiple data lines before JSON-parsing', () => {
    // A provider may split one JSON payload across two data: lines; the parser
    // joins them (SSE spec) then parses the assembled payload.
    const event = 'data: {"choices": [\ndata: {"delta": {"content": "x"}}]}\n\n'
    expect(parseSseEvent(event)).toEqual({ content: 'x', reasoning: '', done: false })
  })

  it('treats an event with choices but no delta content as empty content', () => {
    const event = `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`
    expect(parseSseEvent(event)).toEqual({ content: '', reasoning: '', done: false })
  })

  it('extracts reasoning_content (DeepSeek/z.ai glm-5.2 style)', () => {
    // Reasoning models emit thinking tokens in a separate field BEFORE the
    // visible content. Surfacing them lets the user see the model is
    // "thinking" rather than staring at a hung UI for tens of seconds.
    expect(parseSseEvent(reasoningDelta('Analyzing the paragraph…'))).toEqual({
      content: '',
      reasoning: 'Analyzing the paragraph…',
      done: false,
    })
  })

  it('extracts `reasoning` as an alias (OpenRouter wrapped style)', () => {
    expect(parseSseEvent(reasoningDeltaAlt('Thinking…'))).toEqual({
      content: '',
      reasoning: 'Thinking…',
      done: false,
    })
  })

  it('extracts content AND reasoning when both are present in one event', () => {
    // Some providers interleave or batch — one event may carry both fields.
    const event = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Hello', reasoning_content: 'Deciding tone…' } }],
    })}\n\n`
    expect(parseSseEvent(event)).toEqual({
      content: 'Hello',
      reasoning: 'Deciding tone…',
      done: false,
    })
  })
})

describe('consumeSse', () => {
  it('forwards each delta to the callback', async () => {
    const received: string[] = []
    await consumeSse(streamOf([delta('a'), delta('b'), DONE]), (d) => received.push(d))
    expect(received.join('')).toBe('ab')
  })

  it('reassembles an event split across stream chunks', async () => {
    const full = `${delta('split-apart')}${DONE}`
    const half = Math.floor(full.length / 2)
    const received: string[] = []
    await consumeSse(streamOf([full.slice(0, half), full.slice(half)]), (d) => received.push(d))
    expect(received.join('')).toBe('split-apart')
  })

  it('normalizes CRLF line endings', async () => {
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: 'crlf' } }] })}\r\n\r\n`
    const received: string[] = []
    await consumeSse(streamOf([event]), (d) => received.push(d))
    expect(received.join('')).toBe('crlf')
  })

  it('rejects with AbortError when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(consumeSse(streamOf([delta('x')]), () => {}, ac.signal)).rejects.toThrow()
  })

  it('rejects with TimeoutError when the stream stalls (no chunks for the idle period)', async () => {
    vi.useFakeTimers()
    try {
      // Stream that never enqueues anything and never closes — emulates a
      // provider that returned 200 + headers then went silent on the body.
      const stalled = new ReadableStream<Uint8Array>({
        start() {
          // intentional no-op
        },
      })
      const promise = consumeSse(stalled, () => {})
      // Advance just shy of the timeout — promise should still be pending.
      await vi.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS - 100)
      let settled = false
      promise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      expect(settled).toBe(false)
      // Cross the threshold.
      await vi.advanceTimersByTimeAsync(200)
      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the idle timer on each chunk (a slow-but-steady stream completes)', async () => {
    vi.useFakeTimers()
    try {
      const enc = new TextEncoder()
      // Stream that emits one delta every (timeout/3) ms, then closes.
      // Without per-chunk reset, this would trip the idle timeout.
      const interval = Math.floor(SSE_IDLE_TIMEOUT_MS / 3)
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 3; i++) {
            await new Promise<void>((r) => setTimeout(r, interval))
            controller.enqueue(enc.encode(delta(`chunk-${i}`)))
          }
          await new Promise<void>((r) => setTimeout(r, interval))
          controller.enqueue(enc.encode(DONE))
          controller.close()
        },
      })
      const received: string[] = []
      const promise = consumeSse(stream, (d) => received.push(d))
      // Drive the stream to completion by advancing timers in steps.
      // Total time: 4 intervals (3 deltas + DONE).
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(Math.floor(interval / 3) + 1)
      }
      await promise
      expect(received.join('')).toBe('chunk-0chunk-1chunk-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards reasoning deltas to onReasoning (separate from content)', async () => {
    // Reasoning model: emits reasoning_content first, then content.
    const content: string[] = []
    const reasoning: string[] = []
    await consumeSse(
      streamOf([reasoningDelta('Thinking A'), reasoningDelta('Thinking B'), delta('Answer'), DONE]),
      (d) => content.push(d),
      undefined,
      (r) => reasoning.push(r),
    )
    expect(content.join('')).toBe('Answer')
    expect(reasoning.join('')).toBe('Thinking AThinking B')
  })

  it('handles events that carry both content and reasoning in one payload', async () => {
    // Some providers batch — one event may carry both fields simultaneously.
    const content: string[] = []
    const reasoning: string[] = []
    const event = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Hi', reasoning_content: 'Deciding…' } }],
    })}\n\n`
    await consumeSse(
      streamOf([event, DONE]),
      (d) => content.push(d),
      undefined,
      (r) => reasoning.push(r),
    )
    expect(content.join('')).toBe('Hi')
    expect(reasoning.join('')).toBe('Deciding…')
  })

  it('does not call onReasoning when not provided (backward-compatible)', async () => {
    // Existing callers that don't pass onReasoning must still work — the
    // optional 4th arg is the contract.
    const content: string[] = []
    await consumeSse(streamOf([reasoningDelta('Ignored'), delta('Kept'), DONE]), (d) =>
      content.push(d),
    )
    // Content flows normally; reasoning silently dropped (no callback).
    expect(content.join('')).toBe('Kept')
  })
})
