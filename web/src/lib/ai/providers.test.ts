import { describe, expect, it } from 'vitest'
import { findPresetByBaseUrl, getPreset, PROVIDER_PRESETS } from './providers'

describe('providers', () => {
  it('includes the expected presets', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(ids).toEqual(['openrouter', 'groq', 'openai', 'together', 'zen', 'custom'])
  })

  it('every preset has a unique id', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('getPreset returns the matching preset', () => {
    expect(getPreset('openrouter').label).toBe('OpenRouter')
    expect(getPreset('groq').label).toBe('Groq')
    expect(getPreset('zen').label).toBe('OpenCode Zen')
  })

  it('getPreset falls back to Custom for unknown id', () => {
    expect(getPreset('nonexistent').id).toBe('custom')
  })

  it('findPresetByBaseUrl matches normalized URLs', () => {
    expect(findPresetByBaseUrl('https://openrouter.ai/api/v1')?.id).toBe('openrouter')
    expect(findPresetByBaseUrl('https://openrouter.ai/api/v1/')?.id).toBe('openrouter')
    expect(findPresetByBaseUrl('https://api.groq.com/openai/v1')?.id).toBe('groq')
    expect(findPresetByBaseUrl('https://opencode.ai/zen/v1')?.id).toBe('zen')
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

  it('Zen preset declares a static free-model dropdown with a default among them', () => {
    const zen = getPreset('zen')
    expect(zen.corsSafe).toBe(true)
    // Static list, so no /models discovery.
    expect(zen.supportsModelsEndpoint).toBe(false)
    expect(zen.models).toBeDefined()
    const ids = zen.models?.map((m) => m.id)
    expect(ids).toContain(zen.defaultModel)
    expect(ids).toEqual(
      expect.arrayContaining([
        'big-pickle',
        'deepseek-v4-flash-free',
        'hy3-free',
        'mimo-v2.5-free',
        'nemotron-3-ultra-free',
        'north-mini-code-free',
      ]),
    )
    // Every surfaced Zen model is free.
    expect(zen.models?.every((m) => m.free === true)).toBe(true)
    // Claude/GPT/Gemini ids (other endpoints) must NOT be listed.
    expect(ids).not.toContain('claude-opus-4-8')
    expect(ids).not.toContain('gpt-5.5')
    expect(ids).not.toContain('glm-5.2')
  })
})
