import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearApiKey } from '../lib/ai/keyring'
import type { AiSettings } from '../lib/ai/types'
import { AiSettingsSection } from './AiSettingsSection'

function cloudAi(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    enabled: true,
    backend: 'cloud',
    inBrowser: { modelId: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
    cloud: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    modal: { beforeUpload: false, afterUpload: true },
    ...overrides,
  }
}

beforeEach(() => clearApiKey())

describe('AiSettingsSection — API key import', () => {
  it('imports a JSON config: sets the key and patches baseUrl/model', async () => {
    const onChange = vi.fn()
    render(<AiSettingsSection ai={cloudAi()} onChange={onChange} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          new File(
            ['{"apiKey":"sk-imported","baseUrl":"https://custom/v1","model":"gpt-4o"}'],
            'key.json',
            { type: 'application/json' },
          ),
        ],
      },
    })
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: { baseUrl: 'https://custom/v1', model: 'gpt-4o' },
        }),
      )
    })
    // Key now held in memory → Forget becomes enabled.
    expect(screen.getByRole('button', { name: /forget api key/i })).toBeEnabled()
  })

  it('imports a plain-text file as the key only (no cloud patch)', async () => {
    const onChange = vi.fn()
    render(<AiSettingsSection ai={cloudAi()} onChange={onChange} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['sk-plain-token'], 'key.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /forget api key/i })).toBeEnabled()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows an error for a JSON file without an apiKey', async () => {
    const onChange = vi.fn()
    render(<AiSettingsSection ai={cloudAi()} onChange={onChange} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [new File(['{"baseUrl":"https://x"}'], 'bad.json', { type: 'application/json' })],
      },
    })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
