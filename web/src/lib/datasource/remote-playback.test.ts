import { describe, expect, it, type Mock, vi } from 'vitest'
import { bookId, voiceId } from '../../types'
import { audioCacheKey } from '../audio-cache'
import type { TtsEngine } from '../tts/types'
import { createServerPlaybackEngine } from './remote-playback'
import { HostedModeUnavailableError, ServerApiError } from './server'

const VOICE = voiceId('en_US-hfc_female-medium')
const BOOK = bookId('b1')

function setup(): { engine: TtsEngine; fetchMock: Mock } {
  const fetchMock = vi.fn<typeof fetch>()
  const engine = createServerPlaybackEngine({ fetchImpl: fetchMock as typeof fetch })
  return { engine, fetchMock }
}

function audioResponse(bytes: Uint8Array<ArrayBuffer>, contentType = 'audio/ogg'): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': contentType },
  })
}

describe('createServerPlaybackEngine — synthesize as audio-by-key fetch', () => {
  it('GETs /api/books/{id}/audio/{contentKey} with the existing audioCacheKey path', async () => {
    const { engine, fetchMock } = setup()
    fetchMock.mockResolvedValue(audioResponse(new Uint8Array([1, 2, 3])))
    const text = 'The caravan rested at the oasis.'

    await engine.synthesize({ text, voiceId: VOICE, bookId: BOOK })

    const key = await audioCacheKey(VOICE, text)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/books/${BOOK}/audio/${key}`,
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    )
  })

  it('returns the served bytes as a Blob plus the computed cacheKey', async () => {
    const { engine, fetchMock } = setup()
    const oggs = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x01])
    fetchMock.mockResolvedValue(audioResponse(oggs))
    const text = 'Second paragraph.'

    const result = await engine.synthesize({ text, voiceId: VOICE, bookId: BOOK })

    const key = await audioCacheKey(VOICE, text)
    expect(result.cacheKey).toBe(key)
    expect(result.audio).toBeInstanceOf(Blob)
    expect(result.audio?.type).toBe('audio/ogg')
    const bytes = result.audio ? new Uint8Array(await result.audio.arrayBuffer()) : new Uint8Array()
    expect(bytes).toEqual(oggs)
    expect(typeof result.durationSeconds).toBe('number')
  })

  it('missing key (404) rejects with ServerApiError pointing at the Synthesize affordance — never a crash', async () => {
    const { engine, fetchMock } = setup()
    fetchMock.mockResolvedValue(new Response('no audio segment', { status: 404 }))

    const err = await engine
      .synthesize({ text: 'Not synthesized yet.', voiceId: VOICE, bookId: BOOK })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ServerApiError)
    expect((err as ServerApiError).status).toBe(404)
    expect((err as ServerApiError).message).toMatch(/Synthesize/i)
  })

  it('other HTTP failures reject with ServerApiError carrying the status', async () => {
    const { engine, fetchMock } = setup()
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))

    await expect(
      engine.synthesize({ text: 'x', voiceId: VOICE, bookId: BOOK }),
    ).rejects.toMatchObject({ name: 'ServerApiError', status: 500 })
  })

  it('network failure rejects with ServerApiError (no status)', async () => {
    const { engine, fetchMock } = setup()
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    const err = await engine
      .synthesize({ text: 'x', voiceId: VOICE, bookId: BOOK })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ServerApiError)
    expect((err as ServerApiError).status).toBeUndefined()
  })

  it('a request without bookId rejects clearly without fetching', async () => {
    const { engine, fetchMock } = setup()

    await expect(engine.synthesize({ text: 'x', voiceId: VOICE })).rejects.toThrow(/book/i)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blank text rejects clearly without a guaranteed-404 round trip', async () => {
    const { engine, fetchMock } = setup()

    await expect(engine.synthesize({ text: '   ', voiceId: VOICE, bookId: BOOK })).rejects.toThrow(
      /speakable/i,
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sequential read-ahead fetches each paragraph under its own key', async () => {
    const { engine, fetchMock } = setup()
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      return audioResponse(new Uint8Array([url.length % 251, 0x4f, 0x47]))
    })
    const texts = ['First.', 'Second.', 'Third.']

    // Mirror the desktop player's primeAhead loop: sequential, awaited.
    for (const text of texts) {
      await engine.synthesize({ text, voiceId: VOICE, bookId: BOOK })
    }

    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [i, text] of texts.entries()) {
      const key = await audioCacheKey(VOICE, text)
      expect(fetchMock).toHaveBeenNthCalledWith(
        i + 1,
        `/api/books/${BOOK}/audio/${key}`,
        expect.anything(),
      )
    }
  })

  it('concurrent calls (scheduler lookahead) each get their own bytes', async () => {
    const { engine, fetchMock } = setup()
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      audioResponse(new Uint8Array([String(input).length, 0x53])),
    )

    const [a, b] = await Promise.all([
      engine.synthesize({ text: 'Alpha.', voiceId: VOICE, bookId: BOOK }),
      engine.synthesize({ text: 'Beta.', voiceId: VOICE, bookId: BOOK }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const keyA = await audioCacheKey(VOICE, 'Alpha.')
    const keyB = await audioCacheKey(VOICE, 'Beta.')
    expect(a.cacheKey).toBe(keyA)
    expect(b.cacheKey).toBe(keyB)
  })
})

describe('createServerPlaybackEngine — voice-management surface (unchanged interim contract)', () => {
  it('lists no voices, stores nothing, and refuses on-device downloads', async () => {
    const { engine } = setup()

    await expect(engine.listVoices()).resolves.toEqual([])
    await expect(engine.isStored(VOICE)).resolves.toBe(false)
    await expect(engine.download(VOICE)).rejects.toBeInstanceOf(HostedModeUnavailableError)
    await expect(engine.remove(VOICE)).resolves.toBeUndefined()
    await expect(engine.clearAllStored()).resolves.toBeUndefined()
  })
})
