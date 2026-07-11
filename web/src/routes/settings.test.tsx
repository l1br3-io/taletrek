import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsProvider } from '../context/settings'
import { _resetDBForTests, getSetting, setSetting } from '../lib/db'
import { type VoiceId, voiceId } from '../types'
import { Settings } from './settings'

const isStoredMock = vi.fn<(id: VoiceId) => Promise<boolean>>()
const downloadMock = vi.fn<(id: VoiceId, cb?: (f: number) => void) => Promise<void>>()

vi.mock('../lib/tts/client', () => ({
  ttsClient: {
    isStored: (id: VoiceId) => isStoredMock(id),
    download: (id: VoiceId, cb?: (f: number) => void) => downloadMock(id, cb),
  },
}))

function withProviders(node: React.ReactElement) {
  return (
    <MemoryRouter>
      <SettingsProvider>{node}</SettingsProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  _resetDBForTests()
  isStoredMock.mockReset()
  downloadMock.mockReset()
  isStoredMock.mockResolvedValue(false)
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
