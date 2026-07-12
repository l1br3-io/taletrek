import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsProvider } from '../context/settings'
import { _clearDBForTests, _resetDBForTests, getSetting, setSetting } from '../lib/db'
import { type VoiceId, voiceId } from '../types'
import { Settings } from './settings'

const isStoredMock = vi.fn<(id: VoiceId) => Promise<boolean>>()
const downloadMock = vi.fn<(id: VoiceId, cb?: (f: number) => void) => Promise<void>>()
const removeMock = vi.fn<(id: VoiceId) => Promise<void>>()

vi.mock('../lib/tts/client', () => ({
  ttsClient: {
    isStored: (id: VoiceId) => isStoredMock(id),
    download: (id: VoiceId, cb?: (f: number) => void) => downloadMock(id, cb),
    remove: (id: VoiceId) => removeMock(id),
  },
}))

const setApiKeyMock = vi.fn<(key: string) => void>()
const clearApiKeyMock = vi.fn<() => void>()
vi.mock('../lib/ai/keyring', () => ({
  getApiKey: (): string | undefined => undefined,
  setApiKey: (key: string) => setApiKeyMock(key),
  clearApiKey: () => clearApiKeyMock(),
}))

function withProviders(node: React.ReactElement) {
  return (
    <MemoryRouter>
      <SettingsProvider>{node}</SettingsProvider>
    </MemoryRouter>
  )
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  isStoredMock.mockReset()
  downloadMock.mockReset()
  removeMock.mockReset()
  setApiKeyMock.mockReset()
  clearApiKeyMock.mockReset()
  isStoredMock.mockResolvedValue(false)
  removeMock.mockResolvedValue(undefined)
})

describe('Settings view', () => {
  it('renders both theme options', () => {
    render(withProviders(<Settings />))
    expect(screen.getByRole('button', { name: /Dark/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sepia/ })).toBeInTheDocument()
  })

  it('reflects a persisted theme from IndexedDB after hydration', async () => {
    await setSetting('app', { theme: 'sepia', fontScale: 1.25 })
    render(withProviders(<Settings />))
    expect(await screen.findByRole('button', { name: /Sepia/, pressed: true })).toBeInTheDocument()
  })

  it('queries stored status for each curated voice on mount', async () => {
    render(withProviders(<Settings />))
    await waitFor(() => {
      expect(isStoredMock).toHaveBeenCalledTimes(8)
    })
  })

  it('marks a voice downloaded after a successful download', async () => {
    isStoredMock.mockResolvedValue(false)
    downloadMock.mockImplementation(async (_id, cb) => {
      cb?.(1)
    })
    render(withProviders(<Settings />))
    await waitFor(() => expect(isStoredMock).toHaveBeenCalledTimes(8))
    const buttons = screen.getAllByRole('button', { name: 'download' })
    const first = buttons[0]
    if (!first) throw new Error('expected a download button')
    await act(async () => {
      fireEvent.click(first)
    })
    await waitFor(() => expect(screen.getByText('downloaded')).toBeInTheDocument())
  })

  it('persists the selected voice id to settings', async () => {
    render(withProviders(<Settings />))
    await waitFor(() => expect(isStoredMock).toHaveBeenCalledTimes(8))
    fireEvent.click(screen.getByText(/Ryan/))
    const stored = await getSetting<{ voiceId: VoiceId }>('app')
    expect(stored?.voiceId).toBe(voiceId('en_US-ryan-medium'))
  })
})

describe('Settings — voices & offline (M5)', () => {
  it('removes a stored voice and clears its badge', async () => {
    isStoredMock.mockImplementation((id) => Promise.resolve(id === voiceId('en_US-ryan-medium')))
    render(withProviders(<Settings />))
    await waitFor(() => expect(isStoredMock).toHaveBeenCalledTimes(8))
    const removeBtn = screen.getByRole('button', { name: /remove Ryan/i })
    await act(async () => {
      fireEvent.click(removeBtn)
    })
    expect(removeMock).toHaveBeenCalledWith(voiceId('en_US-ryan-medium'))
    // badge gone → all eight voices are downloadable again
    expect(screen.queryByText('downloaded')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'download' })).toHaveLength(8)
  })

  it('shows the offline badge as not-ready when no voice is stored', async () => {
    render(withProviders(<Settings />))
    await waitFor(() => expect(isStoredMock).toHaveBeenCalledTimes(8))
    expect(screen.getByText('Voice not downloaded')).toBeInTheDocument()
  })

  it('shows Ready offline when the active voice is stored', async () => {
    isStoredMock.mockImplementation((id) =>
      Promise.resolve(id === voiceId('en_US-hfc_female-medium')),
    )
    render(withProviders(<Settings />))
    await waitFor(() => expect(screen.getByText('Ready offline')).toBeInTheDocument())
  })

  it('shows Offline when the browser goes offline', async () => {
    render(withProviders(<Settings />))
    await waitFor(() => expect(isStoredMock).toHaveBeenCalledTimes(8))
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(screen.getByText('Offline')).toBeInTheDocument()
  })
})

async function renderHydrated() {
  await setSetting('app', { fontScale: 1.25 })
  render(withProviders(<Settings />))
  await screen.findByText('×1.25')
}

describe('Settings — text cleaning', () => {
  it('renders the master toggle and four filter rows when enabled', async () => {
    await renderHydrated()
    expect(
      screen.getByRole('button', { name: /toggle text cleaning/i, pressed: true }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /links & urls/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /image markers/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /footnote references/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /page numbers/i })).toBeInTheDocument()
  })

  it('toggles a filter and persists it to IndexedDB', async () => {
    await renderHydrated()
    const urls = screen.getByRole('button', { name: /links & urls/i })
    expect(urls).toHaveAttribute('aria-pressed', 'true')
    await act(async () => {
      fireEvent.click(urls)
    })
    expect(urls).toHaveAttribute('aria-pressed', 'false')
    const stored = await getSetting<{ cleaning: { filters: { urls: boolean } } }>('app')
    expect(stored?.cleaning.filters.urls).toBe(false)
  })

  it('disables the master toggle and hides the filter rows', async () => {
    await renderHydrated()
    const master = screen.getByRole('button', { name: /toggle text cleaning/i })
    await act(async () => {
      fireEvent.click(master)
    })
    expect(master).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: /links & urls/i })).not.toBeInTheDocument()
  })
})

describe('Settings — pronunciation dictionary', () => {
  it('adds, edits, and persists a pronunciation entry', async () => {
    await renderHydrated()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add word/i }))
    })
    const findInput = screen.getByLabelText(/word to replace/i)
    const replaceInput = screen.getByLabelText(/^replacement$/i)
    await act(async () => {
      fireEvent.change(findInput, { target: { value: 'Siobhan' } })
    })
    await act(async () => {
      fireEvent.change(replaceInput, { target: { value: 'shi-vawn' } })
    })
    const stored = await getSetting<{
      cleaning: { pronunciation: { find: string; replace: string }[] }
    }>('app')
    expect(stored?.cleaning.pronunciation).toEqual([
      expect.objectContaining({ find: 'Siobhan', replace: 'shi-vawn' }),
    ])
  })

  it('deletes a pronunciation entry', async () => {
    await renderHydrated()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add word/i }))
    })
    expect(screen.getByLabelText(/word to replace/i)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remove entry/i }))
    })
    expect(screen.queryByLabelText(/word to replace/i)).not.toBeInTheDocument()
  })
})

describe('Settings — AI transforms (M6)', () => {
  it('renders only the enable toggle when disabled (default)', async () => {
    await renderHydrated()
    expect(
      screen.getByRole('button', { name: /toggle AI transforms/i, pressed: false }),
    ).toBeInTheDocument()
    // backend radio + fields are hidden until enabled
    expect(screen.queryByRole('button', { name: /use on-device backend/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/cloud base url/i)).not.toBeInTheDocument()
  })

  it('reveals the config + default in-browser backend when enabled', async () => {
    await renderHydrated()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /toggle AI transforms/i }))
    })
    expect(
      screen.getByRole('button', { name: /use on-device backend/i, pressed: true }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/in-browser model id/i)).toHaveValue(
      'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    )
  })

  it('swaps to cloud fields on backend change and persists it', async () => {
    await renderHydrated()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /toggle AI transforms/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use cloud backend/i }))
    })
    expect(screen.getByLabelText(/cloud base url/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/cloud model/i)).toBeInTheDocument()
    const stored = await getSetting<{ ai: { backend: string } }>('app')
    expect(stored?.ai.backend).toBe('cloud')
  })

  it('saves the API key to the in-memory keyring (not to settings)', async () => {
    await renderHydrated()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /toggle AI transforms/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use cloud backend/i }))
    })
    const keyInput = screen.getByLabelText(/cloud api key/i)
    await act(async () => {
      fireEvent.change(keyInput, { target: { value: 'sk-secret-123' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save api key/i }))
    })
    expect(setApiKeyMock).toHaveBeenCalledWith('sk-secret-123')
    // The key must never be persisted to settings (ADR-0004)
    const stored = await getSetting<{ ai?: { key?: string } }>('app')
    expect(stored?.ai?.key).toBeUndefined()
  })

  it('forgets the key via the keyring', async () => {
    // Seed the in-memory keyring as "has key" so the Forget button enables.
    setApiKeyMock.mockImplementation(() => undefined)
    await renderHydrated()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /toggle AI transforms/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use cloud backend/i }))
    })
    const keyInput = screen.getByLabelText(/cloud api key/i)
    await act(async () => {
      fireEvent.change(keyInput, { target: { value: 'sk-x' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save api key/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /forget api key/i }))
    })
    expect(clearApiKeyMock).toHaveBeenCalled()
  })

  it('persists the modal-timing flags', async () => {
    await renderHydrated()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /toggle AI transforms/i }))
    })
    const beforeCheckbox = screen.getByLabelText(/before upload/i)
    expect(beforeCheckbox).not.toBeChecked()
    await act(async () => {
      fireEvent.click(beforeCheckbox)
    })
    const stored = await getSetting<{ ai: { modal: { beforeUpload: boolean } } }>('app')
    expect(stored?.ai.modal.beforeUpload).toBe(true)
  })
})
