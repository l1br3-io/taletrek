import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests } from '../../lib/install-prompt'
import { InstallPrompt } from './InstallPrompt'

/** A synthetic beforeinstallprompt event with mockable prompt/userChoice. */
function bipEvent(): Event {
  const e = new Event('beforeinstallprompt')
  Object.defineProperty(e, 'prompt', {
    value: vi.fn().mockResolvedValue(undefined),
    configurable: true,
  })
  Object.defineProperty(e, 'userChoice', {
    value: Promise.resolve({ outcome: 'accepted' }),
    configurable: true,
  })
  return e
}

function setStandalone(value: boolean) {
  // jsdom has no matchMedia by default — install a stub.
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('standalone') ? value : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  )
}

beforeEach(() => {
  localStorage.clear()
  setStandalone(false)
  // Default userAgent is a desktop Chromium-ish string (not iOS).
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    configurable: true,
  })
  _resetForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('InstallPrompt', () => {
  it('renders nothing until beforeinstallprompt fires', () => {
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers Install after beforeinstallprompt and prompts on click', async () => {
    render(<InstallPrompt />)
    const e = bipEvent()
    act(() => {
      window.dispatchEvent(e)
    })
    const install = await screen.findByRole('button', { name: 'Install' })
    await act(async () => {
      fireEvent.click(install)
    })
    // the event's prompt() was invoked
    const promptSpy = (e as unknown as { prompt: () => Promise<void> }).prompt
    expect(promptSpy).toHaveBeenCalled()
  })

  it('is hidden once installed (standalone display-mode)', () => {
    setStandalone(true)
    _resetForTests()
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('hides on dismiss and persists (sticky) across remounts', () => {
    const { unmount } = render(<InstallPrompt />)
    act(() => {
      window.dispatchEvent(bipEvent())
    })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss install prompt' }))
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    unmount()
    // remount → still dismissed (localStorage)
    const { container } = render(<InstallPrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the iOS manual instructions on an iPhone user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      configurable: true,
    })
    render(<InstallPrompt />)
    expect(screen.getByText(/Add to Home Screen/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  })

  it('still shows Install when beforeinstallprompt fired BEFORE mount', () => {
    // The pre-2026-07 regression: the listener lived in a useEffect, so an
    // event fired before the component mounted was lost. The module-load
    // capture in lib/install-prompt.ts fixes this — the captured event is
    // observed via useSyncExternalStore on first render.
    act(() => {
      window.dispatchEvent(bipEvent())
    })
    render(<InstallPrompt />)
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument()
  })
})
