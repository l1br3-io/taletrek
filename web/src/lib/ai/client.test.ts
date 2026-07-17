import { describe, expect, it } from 'vitest'
import { getAiEngine } from './client'
import { CloudLlmEngine } from './engines/openai'
import type { AiSettings } from './types'

function cloudSettings(): AiSettings {
  return {
    enabled: true,
    backend: 'cloud',
    cloud: {
      providers: [
        {
          id: 'p1',
          presetId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          contextLimit: 32768,
        },
      ],
      activeProviderId: 'p1',
    },
    transformDefs: [],
  }
}

describe('getAiEngine', () => {
  it('returns a CloudLlmEngine when an active provider is configured', () => {
    const s = cloudSettings()
    expect(getAiEngine(s)).toBeInstanceOf(CloudLlmEngine)
  })

  it('returns null when no provider is configured', () => {
    const s: AiSettings = {
      ...cloudSettings(),
      cloud: { providers: [], activeProviderId: null },
    }
    expect(getAiEngine(s)).toBeNull()
  })

  it('returns null when active provider id does not match any provider', () => {
    const s: AiSettings = {
      ...cloudSettings(),
      cloud: { providers: cloudSettings().cloud.providers, activeProviderId: 'nonexistent' },
    }
    expect(getAiEngine(s)).toBeNull()
  })

  it('respects the configured cloud model + baseUrl', async () => {
    const s: AiSettings = {
      ...cloudSettings(),
      cloud: {
        providers: [
          {
            id: 'p1',
            presetId: 'together',
            baseUrl: 'https://api.together.xyz/v1',
            model: 'meta-llama/Llama-3-70B',
            contextLimit: 32768,
          },
        ],
        activeProviderId: 'p1',
      },
    }
    const engine = getAiEngine(s) as CloudLlmEngine
    expect(await engine.isReady()).toBe(false)
  })
})
