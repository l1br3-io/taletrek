import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeleteAllDataDialog } from './DeleteAllDataDialog'

describe('DeleteAllDataDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<DeleteAllDataDialog open={false} onResult={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('disables the confirm button until DELETE is typed', () => {
    const onResult = vi.fn()
    render(<DeleteAllDataDialog open onResult={onResult} />)
    const confirm = screen.getByRole('button', { name: /delete everything/i })
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), {
      target: { value: 'DELETE' },
    })
    expect(confirm).not.toBeDisabled()
  })

  it('calls onResult(true) on confirm', () => {
    const onResult = vi.fn()
    render(<DeleteAllDataDialog open onResult={onResult} />)
    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), {
      target: { value: 'delete' },
    })
    fireEvent.click(screen.getByRole('button', { name: /delete everything/i }))
    expect(onResult).toHaveBeenCalledWith(true)
  })

  it('calls onResult(false) on cancel', () => {
    const onResult = vi.fn()
    render(<DeleteAllDataDialog open onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onResult).toHaveBeenCalledWith(false)
  })

  it('does not confirm on a partial match', () => {
    const onResult = vi.fn()
    render(<DeleteAllDataDialog open onResult={onResult} />)
    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), {
      target: { value: 'DELE' },
    })
    expect(screen.getByRole('button', { name: /delete everything/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /delete everything/i }))
    expect(onResult).not.toHaveBeenCalled()
  })
})
