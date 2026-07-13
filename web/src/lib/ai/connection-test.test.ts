import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testConnection } from './connection-test'

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockResponse(ok: boolean, status: number, statusText: string, body = ''): Response {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  } as unknown as Response
}

describe('testConnection', () => {
  it('returns success on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(true, 200, 'OK')),
    )
    const result = await testConnection('https://api.openai.com/v1', 'sk-test', 'gpt-4o-mini')
    expect(result).toEqual({ type: 'success' })
  })

  it('returns auth-error on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(false, 401, 'Unauthorized')),
    )
    const result = await testConnection('https://api.openai.com/v1', 'sk-bad', 'gpt-4o-mini')
    expect(result).toEqual({ type: 'auth-error' })
  })

  it('returns auth-error on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(false, 403, 'Forbidden')),
    )
    const result = await testConnection('https://api.openai.com/v1', 'sk-bad', 'gpt-4o-mini')
    expect(result).toEqual({ type: 'auth-error' })
  })

  it('returns model-not-found on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(false, 404, 'Not Found')),
    )
    const result = await testConnection('https://api.openai.com/v1', 'sk-test', 'nonexistent-model')
    expect(result).toEqual({ type: 'model-not-found' })
  })

  it('returns cors on network error (TypeError)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const result = await testConnection('https://api.openai.com/v1', 'sk-test', 'gpt-4o-mini')
    expect(result).toEqual({ type: 'cors' })
  })

  it('returns error with status for other HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockResponse(false, 429, 'Too Many Requests', 'rate limited')),
    )
    const result = await testConnection('https://api.openai.com/v1', 'sk-test', 'gpt-4o-mini')
    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.status).toBe(429)
      expect(result.message).toContain('429')
    }
  })

  it('posts to {baseUrl}/chat/completions with max_tokens=1', async () => {
    const fm = vi.fn(async () => mockResponse(true, 200, 'OK'))
    vi.stubGlobal('fetch', fm)

    await testConnection('https://api.openai.com/v1', 'sk-test', 'gpt-4o-mini')

    const [url, init] = fm.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.max_tokens).toBe(1)
    expect(body.stream).toBe(false)
    expect(body.model).toBe('gpt-4o-mini')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
  })

  it('trims trailing slashes from baseUrl', async () => {
    const fm = vi.fn(async () => mockResponse(true, 200, 'OK'))
    vi.stubGlobal('fetch', fm)

    await testConnection('https://api.openai.com/v1///', 'sk-test', 'gpt-4o-mini')

    const [url] = fm.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('rethrows AbortError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError')
      }),
    )

    await expect(
      testConnection('https://api.openai.com/v1', 'sk-test', 'gpt-4o-mini'),
    ).rejects.toThrow('aborted')
  })
})
