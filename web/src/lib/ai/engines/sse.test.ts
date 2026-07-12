import { describe, expect, it } from 'vitest'
import { consumeSse, parseSseEvent } from './sse'

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

const DONE = 'data: [DONE]\n\n'

describe('parseSseEvent', () => {
  it('extracts the delta content from a data event', () => {
    expect(parseSseEvent(delta('hi'))).toEqual({ content: 'hi', done: false })
  })

  it('flags the terminal [DONE] event', () => {
    expect(parseSseEvent(DONE)).toEqual({ content: '', done: true })
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
      done: false,
    })
  })

  it('concatenates multiple data lines before JSON-parsing', () => {
    // A provider may split one JSON payload across two data: lines; the parser
    // joins them (SSE spec) then parses the assembled payload.
    const event = 'data: {"choices": [\ndata: {"delta": {"content": "x"}}]}\n\n'
    expect(parseSseEvent(event)).toEqual({ content: 'x', done: false })
  })

  it('treats an event with choices but no delta content as empty content', () => {
    const event = `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`
    expect(parseSseEvent(event)).toEqual({ content: '', done: false })
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
})
