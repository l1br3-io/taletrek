import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OutlineSheet } from './OutlineSheet'
import type { OutlineState } from './useOutline'

const idle: OutlineState = { type: 'idle' }

describe('OutlineSheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <OutlineSheet open={false} state={idle} format="pdf" online onClose={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the re-process title for PDFs', () => {
    render(<OutlineSheet open state={idle} format="pdf" online onClose={vi.fn()} />)
    expect(screen.getByText('Re-process outline')).toBeInTheDocument()
  })

  it('shows the detect-chapters title for non-PDFs', () => {
    render(<OutlineSheet open state={idle} format="txt" online onClose={vi.fn()} />)
    expect(screen.getByText('Detect chapters')).toBeInTheDocument()
  })

  it('shows the "Use PDF outline" button for PDFs', () => {
    render(
      <OutlineSheet
        open
        state={idle}
        format="pdf"
        online
        onUsePdfOutline={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: /Use the PDF's embedded outline/i }),
    ).toBeInTheDocument()
  })

  it('hides the "Use PDF outline" button for non-PDFs', () => {
    render(
      <OutlineSheet
        open
        state={idle}
        format="txt"
        online
        onUsePdfOutline={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.queryByRole('button', { name: /Use the PDF's embedded outline/i }),
    ).not.toBeInTheDocument()
  })

  it('hides the "Use PDF outline" button when no handler is provided', () => {
    render(<OutlineSheet open state={idle} format="pdf" online onClose={vi.fn()} />)
    expect(
      screen.queryByRole('button', { name: /Use the PDF's embedded outline/i }),
    ).not.toBeInTheDocument()
  })

  it('shows the AI button only when handler is provided', () => {
    const { rerender } = render(
      <OutlineSheet open state={idle} format="pdf" online onClose={vi.fn()} />,
    )
    expect(
      screen.queryByRole('button', { name: /Detect chapters with AI/i }),
    ).not.toBeInTheDocument()

    rerender(
      <OutlineSheet open state={idle} format="pdf" online onDetectAi={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: /Detect chapters with AI/i })).toBeInTheDocument()
  })

  it('disables AI button when offline', () => {
    render(
      <OutlineSheet
        open
        state={idle}
        format="pdf"
        online={false}
        onDetectAi={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const aiButton = screen.getByRole('button', { name: /Detect chapters with AI/i })
    expect(aiButton).toBeDisabled()
  })
})
