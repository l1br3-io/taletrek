import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetModelCacheForTests, fetchModels, invalidateModels } from './models'

beforeEach(() => _resetModelCacheForTests())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockFetch(data: unknown[]): ReturnType<typeof vi.fn> {
  return vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data }),
      }) as unknown as Response,
  )
}

describe('fetchModels', () => {
  it('fetches from {baseUrl}/models', async () => {
    const fm = mockFetch([{ id: 'gpt-4o-mini' }])
    vi.stubGlobal('fetch', fm)

    await fetchModels('https://api.openai.com/v1')

    expect(fm).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('returns ModelInfo with id from response', async () => {
    vi.stubGlobal('fetch', mockFetch([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }]))

    const models = await fetchModels('https://api.openai.com/v1')
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('parses OpenRouter pricing to set free=true for $0 models', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          id: 'meta-llama/llama-3.1-8b-instruct:free',
          name: 'Llama 3.1 8B Free',
          context_length: 128000,
          pricing: { prompt: '0', completion: '0' },
        },
        {
          id: 'openai/gpt-4o',
          name: 'GPT-4o',
          context_length: 128000,
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ]),
    )

    const models = await fetchModels('https://openrouter.ai/api/v1')
    expect(models[0]).toMatchObject({
      id: 'meta-llama/llama-3.1-8b-instruct:free',
      free: true,
      contextLength: 128000,
      promptPrice: '0',
    })
    expect(models[1]).toMatchObject({
      id: 'openai/gpt-4o',
      free: false,
      promptPrice: '0.0000025',
    })
  })

  it('marks Groq models as free (no pricing in response)', async () => {
    vi.stubGlobal('fetch', mockFetch([{ id: 'llama-3.1-8b-instant', owned_by: 'Meta' }]))

    const models = await fetchModels('https://api.groq.com/openai/v1')
    expect(models[0]).toMatchObject({ id: 'llama-3.1-8b-instant', free: true })
  })

  it('sorts free models first, then alphabetically', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        { id: 'zzz-paid' },
        { id: 'aaa-paid' },
        { id: 'bbb-free', pricing: { prompt: '0', completion: '0' } },
        { id: 'aaa-free', pricing: { prompt: '0', completion: '0' } },
      ]),
    )

    const models = await fetchModels('https://openrouter.ai/api/v1')
    expect(models.map((m) => m.id)).toEqual(['aaa-free', 'bbb-free', 'aaa-paid', 'zzz-paid'])
  })

  it('sends Authorization header when apiKey is provided', async () => {
    const fm = mockFetch([{ id: 'm1' }])
    vi.stubGlobal('fetch', fm)

    await fetchModels('https://api.openai.com/v1', 'sk-test')

    const [, init] = fm.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('omits Authorization header when no apiKey', async () => {
    const fm = mockFetch([{ id: 'm1' }])
    vi.stubGlobal('fetch', fm)

    await fetchModels('https://openrouter.ai/api/v1')

    const [, init] = fm.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('caches results — second call does not fetch', async () => {
    const fm = mockFetch([{ id: 'm1' }])
    vi.stubGlobal('fetch', fm)

    await fetchModels('https://api.openai.com/v1')
    await fetchModels('https://api.openai.com/v1')

    expect(fm).toHaveBeenCalledTimes(1)
  })

  it('invalidateModels forces a re-fetch', async () => {
    const fm = mockFetch([{ id: 'm1' }])
    vi.stubGlobal('fetch', fm)

    await fetchModels('https://api.openai.com/v1')
    invalidateModels('https://api.openai.com/v1')
    await fetchModels('https://api.openai.com/v1')

    expect(fm).toHaveBeenCalledTimes(2)
  })

  it('trims trailing slashes from baseUrl', async () => {
    const fm = mockFetch([{ id: 'm1' }])
    vi.stubGlobal('fetch', fm)

    await fetchModels('https://api.openai.com/v1///')

    expect(fm.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models')
  })

  it('throws on non-200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
          }) as unknown as Response,
      ),
    )

    await expect(fetchModels('https://api.openai.com/v1')).rejects.toThrow('Failed to list models')
  })

  it('handles empty data array', async () => {
    vi.stubGlobal('fetch', mockFetch([]))
    const models = await fetchModels('https://api.openai.com/v1')
    expect(models).toEqual([])
  })
})
