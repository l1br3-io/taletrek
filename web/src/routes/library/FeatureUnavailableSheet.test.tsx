import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FeatureUnavailableSheet } from './FeatureUnavailableSheet'

describe('FeatureUnavailableSheet', () => {
  it('renders transform title + body + Settings button for no-provider', () => {
    const onClose = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <FeatureUnavailableSheet
        open
        feature="transform"
        reason="no-provider"
        onClose={onClose}
        onOpenSettings={onOpenSettings}
      />,
    )
    expect(screen.getByRole('heading', { name: /transform needs a provider/i })).toBeInTheDocument()
    expect(screen.getByText(/no provider is configured/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /open ai settings/i }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('suppresses the Settings button when reason is offline (reconnecting is the fix)', () => {
    render(
      <FeatureUnavailableSheet
        open
        feature="pronunciation"
        reason="offline"
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(screen.getByText(/you're offline/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open ai settings/i })).not.toBeInTheDocument()
  })

  it('Escape closes', () => {
    const onClose = vi.fn()
    render(
      <FeatureUnavailableSheet
        open
        feature="transform"
        reason="no-provider"
        onClose={onClose}
        onOpenSettings={vi.fn()}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders nothing when open is false', () => {
    const { container } = render(
      <FeatureUnavailableSheet
        open={false}
        feature="transform"
        reason="no-provider"
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
