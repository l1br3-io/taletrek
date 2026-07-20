import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StreamChip, StreamingCursor } from './StreamingBlock'

describe('StreamChip', () => {
  it('renders opLabel with the ❯ eyebrow', () => {
    render(<StreamChip opLabel="cleanup" />)
    expect(screen.getByText('❯')).toBeInTheDocument()
    expect(screen.getByText('cleanup')).toBeInTheDocument()
  })

  it('uses default data-testid="stream-chip"', () => {
    render(<StreamChip opLabel="cleanup" />)
    expect(screen.getByTestId('stream-chip')).toBeInTheDocument()
  })

  it('omits Stop button when onStop is undefined (M13 chunk mode)', () => {
    render(<StreamChip opLabel="cleanup" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders Stop button with accessible label when onStop provided (F8 paragraph mode)', () => {
    render(<StreamChip opLabel="cleanup" onStop={() => {}} />)
    const stop = screen.getByRole('button', { name: 'Stop cleanup' })
    expect(stop).toBeInTheDocument()
  })

  it('invokes onStop when Stop clicked', () => {
    const onStop = vi.fn()
    render(<StreamChip opLabel="cleanup" onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop cleanup' }))
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('honors custom data-testid override', () => {
    render(<StreamChip opLabel="cleanup" data-testid="chunk-chip" />)
    expect(screen.getByTestId('chunk-chip')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-chip')).not.toBeInTheDocument()
  })
})

describe('StreamingCursor', () => {
  it('renders the █ glyph with tt-cursor + text-accent classes', () => {
    const { container } = render(<StreamingCursor />)
    const span = container.firstElementChild
    expect(span).not.toBeNull()
    expect(span?.classList.contains('tt-cursor')).toBe(true)
    expect(span?.classList.contains('text-accent')).toBe(true)
    expect(span?.textContent).toBe('█')
  })

  it('is aria-hidden (token flood stays out of the announcement queue)', () => {
    render(<StreamingCursor />)
    const span = document.querySelector('.tt-cursor')
    expect(span?.getAttribute('aria-hidden')).toBe('true')
  })

  it('merges caller-supplied className', () => {
    const { container } = render(<StreamingCursor className="custom-class" />)
    const span = container.firstElementChild
    expect(span?.classList.contains('custom-class')).toBe(true)
    expect(span?.classList.contains('tt-cursor')).toBe(true)
  })
})
