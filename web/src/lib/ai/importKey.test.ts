import { describe, expect, it } from 'vitest'
import { parseKeyFile } from './importKey'

describe('parseKeyFile', () => {
  it('parses a plain-text file as the key itself', () => {
    expect(parseKeyFile('sk-abc123\n')).toEqual({ ok: true, apiKey: 'sk-abc123' })
  })

  it('trims whitespace around a plain-text key', () => {
    expect(parseKeyFile('   sk-token   ')).toEqual({ ok: true, apiKey: 'sk-token' })
  })

  it('parses a JSON object with apiKey only', () => {
    expect(parseKeyFile('{ "apiKey": "sk-json" }')).toEqual({ ok: true, apiKey: 'sk-json' })
  })

  it('parses a JSON object with apiKey, baseUrl, and model', () => {
    const result = parseKeyFile(
      '{ "apiKey": "sk-json", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" }',
    )
    expect(result).toEqual({
      ok: true,
      apiKey: 'sk-json',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    })
  })

  it('rejects an empty file', () => {
    expect(parseKeyFile('   ')).toEqual({ ok: false, error: 'File is empty.' })
  })

  it('rejects JSON without an apiKey field', () => {
    const result = parseKeyFile('{ "baseUrl": "https://x" }')
    expect(result.ok).toBe(false)
  })

  it('rejects JSON where apiKey is not a string', () => {
    const result = parseKeyFile('{ "apiKey": 123 }')
    expect(result.ok).toBe(false)
  })

  it('treats a JSON array as invalid (no apiKey)', () => {
    const result = parseKeyFile('[1, 2, 3]')
    expect(result.ok).toBe(false)
  })
})
