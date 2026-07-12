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
    cloud: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    modal: { beforeUpload: false, afterUpload: true },
  }
}

describe('createAiEngine', () => {
  it('returns a CloudLlmEngine when backend is cloud', () => {
    const s = cloudSettings()
    expect(createAiEngine(s)).toBeInstanceOf(CloudLlmEngine)
  })

  it('returns a WebLlmEngine when backend is in-browser', () => {
    const s: AiSettings = { ...cloudSettings(), backend: 'in-browser' }
    const engine = createAiEngine(s)
    expect(engine).toBeInstanceOf(WebLlmEngine)
    // Construction is cheap: no worker spawned. (isReady probes WebGPU but
    // jsdom has none, so this resolves false without spinning anything up.)
  })

  it('respects the configured cloud model + baseUrl', async () => {
    const s: AiSettings = {
      ...cloudSettings(),
      cloud: { baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3-70B' },
    }
    const engine = createAiEngine(s) as CloudLlmEngine
    expect(await engine.isReady()).toBe(false) // no key set
  })
})
