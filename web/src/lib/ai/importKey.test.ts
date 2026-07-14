import { describe, expect, it } from 'vitest'
import { parseKeyFile } from './importKey'

describe('parseKeyFile', () => {
  it('parses a JSON object with apiKey only', () => {
    expect(parseKeyFile('{ "apiKey": "sk-json" }')).toEqual({ ok: true, apiKey: 'sk-json' })
  })

  it('parses a JSON object with apiKey, baseUrl, model, and provider', () => {
    const result = parseKeyFile(
      '{ "apiKey": "sk-json", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini", "provider": "openai" }',
    )
    expect(result).toEqual({
      ok: true,
      apiKey: 'sk-json',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      provider: 'openai',
    })
  })

  it('trims whitespace around field values', () => {
    const result = parseKeyFile('{ "apiKey": "  sk-json  ", "provider": "  groq  " }')
    expect(result).toEqual({ ok: true, apiKey: 'sk-json', provider: 'groq' })
  })

  it('rejects an empty file', () => {
    expect(parseKeyFile('   ')).toEqual({ ok: false, error: 'File is empty.' })
  })

  it('rejects non-JSON input (no plain-text fallback)', () => {
    const result = parseKeyFile('sk-abc123')
    expect(result.ok).toBe(false)
  })

  it('rejects JSON without an apiKey field', () => {
    const result = parseKeyFile('{ "baseUrl": "https://x", "provider": "openai" }')
    expect(result.ok).toBe(false)
  })

  it('rejects JSON where apiKey is not a string', () => {
    const result = parseKeyFile('{ "apiKey": 123 }')
    expect(result.ok).toBe(false)
  })

  it('treats a JSON array as invalid', () => {
    const result = parseKeyFile('[1, 2, 3]')
    expect(result.ok).toBe(false)
  })

  it('ignores the legacy "presetId" field (schema renamed to provider)', () => {
    const result = parseKeyFile('{ "apiKey": "sk-json", "presetId": "openai" }')
    expect(result).toEqual({ ok: true, apiKey: 'sk-json' })
  })
})
