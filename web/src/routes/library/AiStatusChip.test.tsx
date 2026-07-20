import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AiStatusChip } from './AiStatusChip'

describe('AiStatusChip', () => {
  it('renders the no-provider message + Settings link', () => {
    const onOpenSettings = vi.fn()
    render(<AiStatusChip reason="no-provider" onOpenSettings={onOpenSettings} />)
    expect(screen.getByText(/AI is on but no provider is set/i)).toBeInTheDocument()
    const link = screen.getByRole('button', { name: /add one in settings/i })
    fireEvent.click(link)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('renders the misconfigured message + Settings link', () => {
    render(<AiStatusChip reason="misconfigured" onOpenSettings={vi.fn()} />)
    expect(screen.getByText(/isn't responding/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /check settings/i })).toBeInTheDocument()
  })

  it('renders the offline message WITHOUT a Settings link (reconnecting is the fix)', () => {
    render(<AiStatusChip reason="offline" onOpenSettings={vi.fn()} />)
    expect(screen.getByText(/you're offline/i)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
