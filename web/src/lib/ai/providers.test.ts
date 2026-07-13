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

  it('Zen preset declares compatible chat/completions model ids and a default among them', () => {
    const zen = getPreset('zen')
    expect(zen.corsSafe).toBe(true)
    expect(zen.supportsModelsEndpoint).toBe(true)
    expect(zen.compatibleModelIds).toBeDefined()
    expect(zen.compatibleModelIds).toContain(zen.defaultModel)
    expect(zen.compatibleModelIds).toContain('glm-5.2')
    // Claude/GPT/Gemini ids (other endpoints) must NOT be listed as compatible.
    expect(zen.compatibleModelIds).not.toContain('claude-opus-4-8')
    expect(zen.compatibleModelIds).not.toContain('gpt-5.5')
  })
})
