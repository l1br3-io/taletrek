import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllKeys, setApiKey } from '../../../lib/ai/keyring'

const secureKeyringMocks = vi.hoisted(() => ({
  isPrfSupported: vi.fn(async () => true),
  getSnapshot: vi.fn(async () => ({ enrolled: false, unlocked: false })),
  enroll: vi.fn(async () => undefined),
  unlock: vi.fn(async () => ({ keysLoaded: 1 })),
  forget: vi.fn(async () => undefined),
}))

vi.mock('../../../lib/crypto/prf', () => ({
  isPrfSupported: secureKeyringMocks.isPrfSupported,
}))

vi.mock('../../../lib/ai/secure-keyring', () => ({
  getSnapshot: secureKeyringMocks.getSnapshot,
  enroll: secureKeyringMocks.enroll,
  unlock: secureKeyringMocks.unlock,
  forget: secureKeyringMocks.forget,
}))

import { BiometricKeyringSection } from './BiometricKeyringSection'

beforeEach(() => {
  clearAllKeys()
  secureKeyringMocks.isPrfSupported.mockResolvedValue(true)
  secureKeyringMocks.getSnapshot.mockResolvedValue({ enrolled: false, unlocked: false })
  secureKeyringMocks.enroll.mockResolvedValue(undefined)
  secureKeyringMocks.unlock.mockResolvedValue({ keysLoaded: 1 })
  secureKeyringMocks.forget.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('BiometricKeyringSection — visibility', () => {
  it('renders nothing while probing', () => {
    secureKeyringMocks.isPrfSupported.mockImplementation(() => new Promise<boolean>(() => {}))
    const { container } = render(
      <BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when PRF is unsupported', async () => {
    secureKeyringMocks.isPrfSupported.mockResolvedValue(false)
    const { container } = render(
      <BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />,
    )
    // Give the probe effect time to settle into `unsupported`.
    await new Promise((r) => setTimeout(r, 50))
    expect(container).toBeEmptyDOMElement()
  })
})

describe('BiometricKeyringSection — not enrolled', () => {
  it('shows Enable button when PRF is supported and not enrolled', async () => {
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /^enable$/i })).toBeInTheDocument()
  })

  it('shows the honest "biometric gate, not a vault" copy', async () => {
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    expect(await screen.findByText(/biometric gate, not a vault/i)).toBeInTheDocument()
  })

  it('refuses to enroll when no key is in memory', async () => {
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^enable$/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/add at least one provider key/i)
    })
    expect(secureKeyringMocks.enroll).not.toHaveBeenCalled()
  })

  it('calls enroll + onEnabledChange(true) when a key is in memory', async () => {
    setApiKey('p1', 'sk-x')
    const onChange = vi.fn()
    render(<BiometricKeyringSection enabled={false} onEnabledChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: /^enable$/i }))
    await waitFor(() => expect(secureKeyringMocks.enroll).toHaveBeenCalledTimes(1))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('surfaces an error if enrollment rejects', async () => {
    setApiKey('p1', 'sk-x')
    secureKeyringMocks.enroll.mockRejectedValue(new Error('User cancelled'))
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^enable$/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/user cancelled/i)
    })
  })
})

describe('BiometricKeyringSection — enrolled-locked', () => {
  beforeEach(() => {
    secureKeyringMocks.getSnapshot.mockResolvedValue({ enrolled: true, unlocked: false })
  })

  it('shows Unlock now + Turn off buttons', async () => {
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /unlock now/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /turn off & forget/i })).toBeInTheDocument()
  })

  it('shows the Locked badge', async () => {
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    expect(await screen.findByText(/^locked$/i)).toBeInTheDocument()
  })

  it('calls unlock on click', async () => {
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /unlock now/i }))
    await waitFor(() => expect(secureKeyringMocks.unlock).toHaveBeenCalledTimes(1))
  })

  it('shows an error when unlock loads zero keys (stale cache)', async () => {
    secureKeyringMocks.unlock.mockResolvedValue({ keysLoaded: 0 })
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /unlock now/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/no cached keys found/i)
    })
  })
})

describe('BiometricKeyringSection — enrolled-unlocked', () => {
  beforeEach(() => {
    secureKeyringMocks.getSnapshot.mockResolvedValue({ enrolled: true, unlocked: true })
  })

  it('shows the Unlocked badge', async () => {
    render(<BiometricKeyringSection enabled={false} onEnabledChange={vi.fn()} />)
    expect(await screen.findByText(/^unlocked$/i)).toBeInTheDocument()
  })

  it('calls forget + onEnabledChange(false) when user turns off', async () => {
    const onChange = vi.fn()
    render(<BiometricKeyringSection enabled={false} onEnabledChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: /turn off & forget/i }))
    await waitFor(() => expect(secureKeyringMocks.forget).toHaveBeenCalledTimes(1))
    expect(onChange).toHaveBeenCalledWith(false)
  })
})

describe('BiometricKeyringSection — stale flag (enabled but no IDB record)', () => {
  // getSnapshot default: {enrolled: false, unlocked: false}

  it('shows "Turn off & forget" even when the IDB record is gone', async () => {
    render(<BiometricKeyringSection enabled={true} onEnabledChange={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /turn off & forget/i })).toBeInTheDocument()
  })

  it('shows a warning explaining the stale state', async () => {
    render(<BiometricKeyringSection enabled={true} onEnabledChange={vi.fn()} />)
    expect(await screen.findByText(/no encrypted cache was found/i)).toBeInTheDocument()
  })

  it('hides the Enable button in stale state (avoids confusion)', async () => {
    render(<BiometricKeyringSection enabled={true} onEnabledChange={vi.fn()} />)
    await screen.findByRole('button', { name: /turn off & forget/i })
    expect(screen.queryByRole('button', { name: /^enable$/i })).not.toBeInTheDocument()
  })

  it('forget clears the stale flag', async () => {
    const onChange = vi.fn()
    render(<BiometricKeyringSection enabled={true} onEnabledChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: /turn off & forget/i }))
    await waitFor(() => expect(secureKeyringMocks.forget).toHaveBeenCalledTimes(1))
    expect(onChange).toHaveBeenCalledWith(false)
  })
})
