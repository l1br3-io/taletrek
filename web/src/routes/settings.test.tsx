import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { SettingsProvider } from '../context/settings'
import { _resetDBForTests, setSetting } from '../lib/db'
import { Settings } from './settings'

function withProviders(node: React.ReactElement) {
  return (
    <MemoryRouter>
      <SettingsProvider>{node}</SettingsProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  _resetDBForTests()
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
