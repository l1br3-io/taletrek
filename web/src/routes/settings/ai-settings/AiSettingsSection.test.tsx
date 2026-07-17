import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllKeys, setApiKey } from '../../../lib/ai/keyring'
import type { AiSettings } from '../../../lib/ai/types'
import { AiSettingsSection } from './AiSettingsSection'

vi.mock('../../../lib/ai/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ai/models')>()
  return { ...actual, fetchModels: vi.fn() }
})

vi.mock('../../../lib/ai/exportKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ai/exportKey')>()
  return { ...actual, downloadKeyFile: vi.fn() }
})

import { downloadKeyFile } from '../../../lib/ai/exportKey'
import { fetchModels } from '../../../lib/ai/models'

const mockFetchModels = vi.mocked(fetchModels)
const mockDownloadKeyFile = vi.mocked(downloadKeyFile)

function cloudAi(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    enabled: true,
    backend: 'cloud',
    cloud: { providers: [], activeProviderId: null },
    transformDefs: [],
    ...overrides,
  }
}

beforeEach(() => {
  clearAllKeys()
  mockFetchModels.mockReset()
  mockDownloadKeyFile.mockReset()
})

describe('AiSettingsSection — provider list', () => {
  it('shows empty state when no providers configured', () => {
    render(<AiSettingsSection ai={cloudAi()} onChange={vi.fn()} />)
    expect(screen.getByText(/no providers configured yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /\+ add provider/i })).toBeInTheDocument()
  })

  it('shows import key file button', () => {
    render(<AiSettingsSection ai={cloudAi()} onChange={vi.fn()} />)
    expect(screen.getByText(/import key file/i)).toBeInTheDocument()
  })
})

describe('AiSettingsSection — add provider flow', () => {
  it('shows preset picker when Add provider is clicked', () => {
    render(<AiSettingsSection ai={cloudAi()} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /\+ add provider/i }))
    expect(screen.getByRole('button', { name: /^openrouter/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^groq/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^openai/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^together/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^custom/i })).toBeInTheDocument()
  })

  it('shows config form after picking a preset', () => {
    render(<AiSettingsSection ai={cloudAi()} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /\+ add provider/i }))
    fireEvent.click(screen.getByRole('button', { name: /openrouter/i }))
    expect(screen.getByText(/configure openrouter/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/cloud api key/i)).toBeInTheDocument()
  })

  it('saves a provider with the preset baseUrl and calls onChange', () => {
    const onChange = vi.fn()
    render(<AiSettingsSection ai={cloudAi()} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /\+ add provider/i }))
    fireEvent.click(screen.getByRole('button', { name: /openrouter/i }))
    fireEvent.click(screen.getByRole('button', { name: /save provider/i }))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        cloud: expect.objectContaining({
          providers: expect.arrayContaining([
            expect.objectContaining({
              presetId: 'openrouter',
              baseUrl: 'https://openrouter.ai/api/v1',
            }),
          ]),
        }),
      }),
    )
  })
})

describe('AiSettingsSection — import key file', () => {
  it('imports a JSON config: creates a provider with key, baseUrl, model', async () => {
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
          cloud: expect.objectContaining({
            providers: expect.arrayContaining([
              expect.objectContaining({
                baseUrl: 'https://custom/v1',
                model: 'gpt-4o',
              }),
            ]),
          }),
        }),
      )
    })
  })

  it('imports a JSON config with provider mapped to a preset', async () => {
    const onChange = vi.fn()
    render(<AiSettingsSection ai={cloudAi()} onChange={onChange} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          new File(['{"apiKey":"sk-or","provider":"openrouter"}'], 'key.json', {
            type: 'application/json',
          }),
        ],
      },
    })
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          cloud: expect.objectContaining({
            providers: expect.arrayContaining([
              expect.objectContaining({
                presetId: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
              }),
            ]),
          }),
        }),
      )
    })
  })

  it('rejects a plain-text file (JSON-only) and shows an error', async () => {
    const onChange = vi.fn()
    render(<AiSettingsSection ai={cloudAi()} onChange={onChange} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['sk-plain-token'], 'key.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('File must be valid JSON.')
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

describe('AiSettingsSection — provider cards', () => {
  it('renders a card for each configured provider', () => {
    const ai = cloudAi({
      cloud: {
        providers: [
          {
            id: 'p1',
            presetId: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'llama-3.1-8b',
          },
          {
            id: 'p2',
            presetId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
          },
        ],
        activeProviderId: 'p1',
      },
    })
    render(<AiSettingsSection ai={ai} onChange={vi.fn()} />)
    expect(screen.getByText('OpenRouter')).toBeInTheDocument()
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('shows Set active button for inactive provider', () => {
    const ai = cloudAi({
      cloud: {
        providers: [
          {
            id: 'p1',
            presetId: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'llama-3.1-8b',
          },
          {
            id: 'p2',
            presetId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
          },
        ],
        activeProviderId: 'p1',
      },
    })
    render(<AiSettingsSection ai={ai} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /set active/i })).toBeInTheDocument()
  })

  it('calls onChange with new active id when Set active is clicked', () => {
    const onChange = vi.fn()
    const ai = cloudAi({
      cloud: {
        providers: [
          {
            id: 'p1',
            presetId: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'llama-3.1-8b',
          },
          {
            id: 'p2',
            presetId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
          },
        ],
        activeProviderId: 'p1',
      },
    })
    render(<AiSettingsSection ai={ai} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /set active/i }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        cloud: expect.objectContaining({ activeProviderId: 'p2' }),
      }),
    )
  })

  it('removes a provider and updates active id', () => {
    const onChange = vi.fn()
    const ai = cloudAi({
      cloud: {
        providers: [
          {
            id: 'p1',
            presetId: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'llama-3.1-8b',
          },
          {
            id: 'p2',
            presetId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
          },
        ],
        activeProviderId: 'p1',
      },
    })
    render(<AiSettingsSection ai={ai} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /remove openrouter/i }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        cloud: expect.objectContaining({
          providers: [
            {
              id: 'p2',
              presetId: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              model: 'gpt-4o-mini',
            },
          ],
          activeProviderId: 'p2',
        }),
      }),
    )
  })
})

describe('AiSettingsSection — static model list (OpenCode Zen)', () => {
  it('renders a dropdown of the free Zen models without fetching /models', async () => {
    render(<AiSettingsSection ai={cloudAi()} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /\+ add provider/i }))
    fireEvent.click(screen.getByRole('button', { name: /opencode zen/i }))

    const select = (await screen.findByLabelText(/cloud model/i)) as HTMLSelectElement
    const ids = Array.from(select.options).map((o) => o.value)
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
    // The free default is selected initially.
    expect(select.value).toBe('deepseek-v4-flash-free')
    // No discovery fetch should have been attempted (static list).
    expect(mockFetchModels).not.toHaveBeenCalled()
  })

  it('defaults the model field to the preset free default on add', () => {
    const onChange = vi.fn()
    render(<AiSettingsSection ai={cloudAi()} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /\+ add provider/i }))
    fireEvent.click(screen.getByRole('button', { name: /opencode zen/i }))
    fireEvent.click(screen.getByRole('button', { name: /save provider/i }))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        cloud: expect.objectContaining({
          providers: expect.arrayContaining([
            expect.objectContaining({
              presetId: 'zen',
              model: 'deepseek-v4-flash-free',
            }),
          ]),
        }),
      }),
    )
  })
})

describe('AiSettingsSection — model dropdown free-only filtering', () => {
  it('shows only free models when provider has a mix of free and paid', async () => {
    mockFetchModels.mockResolvedValue([
      { id: 'free-a', free: true, contextLength: 131072 },
      { id: 'paid-a', free: false, promptPrice: '0.001' },
      { id: 'free-b', free: true, contextLength: 32768 },
      { id: 'paid-b', free: false, promptPrice: '0.003' },
    ])
    render(<AiSettingsSection ai={cloudAi()} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /\+ add provider/i }))
    fireEvent.click(screen.getByRole('button', { name: /openrouter/i }))

    await waitFor(() => {
      const select = screen.getByLabelText(/cloud model/i) as HTMLSelectElement
      const optionValues = Array.from(select.options).map((o) => o.value)
      expect(optionValues).toContain('free-a')
      expect(optionValues).toContain('free-b')
      expect(optionValues).not.toContain('paid-a')
      expect(optionValues).not.toContain('paid-b')
    })
    expect(screen.getByText(/2 paid hidden/i)).toBeInTheDocument()
  })

  it('shows all models when none are free (e.g. OpenAI)', async () => {
    mockFetchModels.mockResolvedValue([
      { id: 'gpt-4o', free: false, promptPrice: '0.005' },
      { id: 'gpt-4o-mini', free: false, promptPrice: '0.0005' },
    ])
    render(<AiSettingsSection ai={cloudAi()} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /\+ add provider/i }))
    fireEvent.click(screen.getByRole('button', { name: /^openai/i }))

    await waitFor(() => {
      const select = screen.getByLabelText(/cloud model/i) as HTMLSelectElement
      const optionValues = Array.from(select.options).map((o) => o.value)
      expect(optionValues).toContain('gpt-4o')
      expect(optionValues).toContain('gpt-4o-mini')
    })
    expect(screen.queryByText(/paid hidden/i)).not.toBeInTheDocument()
  })

  it('shows (current) for a selected model that is paid when free models exist', async () => {
    mockFetchModels.mockResolvedValue([
      { id: 'free-a', free: true, contextLength: 131072 },
      { id: 'paid-a', free: false, promptPrice: '0.001' },
    ])
    const ai = cloudAi({
      cloud: {
        providers: [
          {
            id: 'p1',
            presetId: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'paid-a',
          },
        ],
        activeProviderId: 'p1',
      },
    })
    render(<AiSettingsSection ai={ai} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }))

    await waitFor(() => {
      const select = screen.getByLabelText(/cloud model/i) as HTMLSelectElement
      const options = Array.from(select.options).map((o) => o.textContent ?? '')
      expect(options.some((t) => t.includes('paid-a') && t.includes('(current)'))).toBe(true)
    })
  })
})

describe('AiSettingsSection — export provider', () => {
  function singleProviderAi(): AiSettings {
    return cloudAi({
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
    })
  }

  it('exports immediately when no key is loaded (no confirm dialog)', () => {
    render(<AiSettingsSection ai={singleProviderAi()} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /export openai/i }))
    expect(mockDownloadKeyFile).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks for confirmation before exporting when a key is in memory', () => {
    setApiKey('p1', 'sk-secret')
    render(<AiSettingsSection ai={singleProviderAi()} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /export openai/i }))
    // Not yet downloaded — the confirm dialog is shown instead.
    expect(mockDownloadKeyFile).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(/api key/i)
    fireEvent.click(screen.getByRole('button', { name: /export with key/i }))
    expect(mockDownloadKeyFile).toHaveBeenCalledTimes(1)
  })
})
