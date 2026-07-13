import { describe, expect, it } from 'vitest'
import { createAiEngine } from './client'
import { CloudLlmEngine } from './engines/openai'
import { WebLlmEngine } from './engines/webllm'
import type { AiSettings } from './types'

function cloudSettings(): AiSettings {
  return {
    enabled: true,
    backend: 'cloud',
    inBrowser: { modelId: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
    cloud: {
      providers: [
        {
          id: 'p1',
          presetId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
        },
      ],
      activeProviderId: 'p1',
    },
  }
}

describe('createAiEngine', () => {
  it('returns a CloudLlmEngine when backend is cloud with an active provider', () => {
    const s = cloudSettings()
    expect(createAiEngine(s)).toBeInstanceOf(CloudLlmEngine)
  })

  it('returns null when backend is cloud but no active provider', () => {
    const s: AiSettings = {
      ...cloudSettings(),
      cloud: { providers: [], activeProviderId: null },
    }
    expect(createAiEngine(s)).toBeNull()
  })

  it('returns null when active provider id does not match any provider', () => {
    const s: AiSettings = {
      ...cloudSettings(),
      cloud: { providers: cloudSettings().cloud.providers, activeProviderId: 'nonexistent' },
    }
    expect(createAiEngine(s)).toBeNull()
  })

  it('returns a WebLlmEngine when backend is in-browser', () => {
    const s: AiSettings = { ...cloudSettings(), backend: 'in-browser' }
    const engine = createAiEngine(s)
    expect(engine).toBeInstanceOf(WebLlmEngine)
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
          },
        ],
        activeProviderId: 'p1',
      },
    }
    const engine = createAiEngine(s) as CloudLlmEngine
    expect(await engine.isReady()).toBe(false)
  })
})
