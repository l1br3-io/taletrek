import { describe, expect, it } from 'vitest'
import { findPresetByBaseUrl, getPreset, PROVIDER_PRESETS } from './providers'

describe('providers', () => {
  it('includes the expected presets', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(ids).toEqual(['openrouter', 'groq', 'openai', 'together', 'custom'])
  })

  it('every preset has a unique id', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('getPreset returns the matching preset', () => {
    expect(getPreset('openrouter').label).toBe('OpenRouter')
    expect(getPreset('groq').label).toBe('Groq')
  })

  it('getPreset falls back to Custom for unknown id', () => {
    expect(getPreset('nonexistent').id).toBe('custom')
  })

  it('findPresetByBaseUrl matches normalized URLs', () => {
    expect(findPresetByBaseUrl('https://openrouter.ai/api/v1')?.id).toBe('openrouter')
    expect(findPresetByBaseUrl('https://openrouter.ai/api/v1/')?.id).toBe('openrouter')
    expect(findPresetByBaseUrl('https://api.groq.com/openai/v1')?.id).toBe('groq')
  })

  it('findPresetByBaseUrl returns undefined for unknown URLs', () => {
    expect(findPresetByBaseUrl('https://example.com/v1')).toBeUndefined()
  })

  it('Custom preset has empty baseUrl', () => {
    expect(getPreset('custom').baseUrl).toBe('')
  })

  it('non-custom presets have non-empty baseUrl and signupUrl', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === 'custom') continue
      expect(p.baseUrl).toBeTruthy()
      expect(p.signupUrl).toBeTruthy()
    }
  })
})
