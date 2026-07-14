import { beforeEach, describe, expect, it } from 'vitest'
import { buildKeyFileObject, downloadKeyFile, keyFileName } from './exportKey'
import { clearAllKeys, setApiKey } from './keyring'
import type { CloudProvider } from './types'

function provider(overrides: Partial<CloudProvider> = {}): CloudProvider {
  return {
    id: 'p1',
    presetId: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    ...overrides,
  }
}

describe('buildKeyFileObject', () => {
  it('maps presetId -> provider and includes model + baseUrl', () => {
    expect(buildKeyFileObject(provider())).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    })
  })

  it('includes the optional label when present', () => {
    expect(buildKeyFileObject(provider({ label: 'My key' }))).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      label: 'My key',
    })
  })

  it('includes the apiKey when one is passed', () => {
    expect(buildKeyFileObject(provider(), 'sk-test')).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    })
  })

  it('omits the apiKey when the value is blank', () => {
    const obj = buildKeyFileObject(provider(), '   ') as unknown as Record<string, unknown>
    expect(obj).not.toHaveProperty('apiKey')
  })
})

describe('keyFileName', () => {
  it('uses the label slug when present', () => {
    expect(keyFileName(provider({ label: 'My OpenAI Key!' }))).toBe('my-openai-key.json')
  })

  it('falls back to the presetId', () => {
    expect(keyFileName(provider({ presetId: 'groq' }))).toBe('groq.json')
  })
})

describe('downloadKeyFile', () => {
  beforeEach(() => clearAllKeys())

  it('includes the apiKey from the in-memory keyring when present', () => {
    setApiKey('p1', 'sk-in-memory')
    const json = downloadKeyFile(provider())
    expect(json).toContain('"apiKey": "sk-in-memory"')
    expect(json).toContain('"provider": "openai"')
    expect(json).toContain('"model": "gpt-4o-mini"')
    expect(json.endsWith('\n')).toBe(true)
  })

  it('omits apiKey when no key is loaded for the provider', () => {
    const json = downloadKeyFile(provider())
    expect(json).not.toContain('apiKey')
    expect(json).toContain('"provider": "openai"')
  })
})
