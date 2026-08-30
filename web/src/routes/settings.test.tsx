import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatasourceProvider } from '../context/datasource'
import { SettingsProvider } from '../context/settings'
import {
  _clearDBForTests,
  _resetDBForTests,
  getSetting,
  putAudioCacheEntry,
  setSetting,
} from '../lib/db'
import { type AudioCacheRecord, newBookId, voiceId } from '../types'
import { Settings } from './settings/SettingsPage'

function withProviders(node: React.ReactElement) {
  return (
    <MemoryRouter>
      <DatasourceProvider>
        <SettingsProvider>{node}</SettingsProvider>
      </DatasourceProvider>
    </MemoryRouter>
  )
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
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

describe('Settings — audio cache', () => {
  it('shows the audio cache Storage section with the current size', async () => {
    const record: AudioCacheRecord = {
      key: 'test-cache',
      blob: new Blob([new Uint8Array(2 * 1024 * 1024)]),
      sizeBytes: 2 * 1024 * 1024,
      synthMs: 1,
      durationSeconds: 1,
      voiceId: voiceId('en_US-hfc_female-medium'),
      lastUsed: Date.now(),
      createdAt: Date.now(),
      bookId: newBookId(),
    }
    await putAudioCacheEntry(record)
    render(withProviders(<Settings />))
    expect(await screen.findByText(/Cached audio: 2 MB \/ 500 MB/)).toBeInTheDocument()
  })

  it('clears the audio cache when the Clear button is clicked', async () => {
    const record: AudioCacheRecord = {
      key: 'to-clear',
      blob: new Blob(['x']),
      sizeBytes: 1024,
      synthMs: 1,
      durationSeconds: 1,
      voiceId: voiceId('en_US-hfc_female-medium'),
      lastUsed: Date.now(),
      createdAt: Date.now(),
      bookId: newBookId(),
    }
    await putAudioCacheEntry(record)
    render(withProviders(<Settings />))
    const clearButton = await screen.findByRole('button', { name: /^Clear$/ })
    await act(async () => {
      fireEvent.click(clearButton)
    })
    expect(await screen.findByText(/Cached audio: 0 MB \/ 500 MB/)).toBeInTheDocument()
  })

  it('renders the cache budget slider with the default value', async () => {
    await renderHydrated()
    const slider = screen.getByLabelText(/audio cache size/i)
    expect(slider).toHaveValue('500')
  })

  it('changes the cache budget and persists it', async () => {
    await renderHydrated()
    const slider = screen.getByLabelText(/audio cache size/i)
    await act(async () => {
      fireEvent.change(slider, { target: { value: '1000' } })
    })
    const stored = await getSetting<{ audioCacheBudgetMb: number }>('app')
    expect(stored?.audioCacheBudgetMb).toBe(1000)
  })
})

vi.mock('vconsole', () => ({ default: vi.fn() }))
