import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TransformState } from '../hooks/useAiTransform'
import type { TransformOp } from '../lib/ai/types'
import { PostProcessModal } from './PostProcessModal'

function renderModal(
  overrides: { state?: TransformState; onProcess?: (ops: TransformOp[]) => void } = {},
) {
  const onProcess = overrides.onProcess ?? vi.fn()
  const onCancel = vi.fn()
  render(
    <PostProcessModal
      open
      state={overrides.state ?? { type: 'idle' }}
      onCancel={onCancel}
      onProcess={onProcess}
    />,
  )
  return { onProcess, onCancel }
}

describe('PostProcessModal', () => {
  it('renders the four transform checkboxes', () => {
    renderModal()
    expect(screen.getByLabelText(/clean up/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/translate/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/summarize/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/simplify/i)).toBeInTheDocument()
  })

  it('shows per-op params only when an op is checked', () => {
    renderModal()
    expect(screen.queryByLabelText(/target language code/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/translate/i))
    expect(screen.getByLabelText(/target language code/i)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/summarize/i))
    expect(screen.getByLabelText(/summarize to fraction/i)).toBeInTheDocument()
  })

  it('Process is disabled until an op is selected, then fires onProcess with the built ops', () => {
    const { onProcess } = renderModal()
    const processBtn = screen.getByRole('button', { name: /process book/i })
    expect(processBtn).toBeDisabled()

    fireEvent.click(screen.getByLabelText(/translate/i))
    expect(processBtn).not.toBeDisabled()
    fireEvent.change(screen.getByLabelText(/target language code/i), { target: { value: 'fr' } })
    fireEvent.click(processBtn)

    expect(onProcess).toHaveBeenCalledWith([{ kind: 'translate', target: 'fr' }] as never)
  })

  it('emits ops in canonical order (cleanup → translate → summarize → simplify)', () => {
    const { onProcess } = renderModal()
    fireEvent.click(screen.getByLabelText(/simplify/i))
    fireEvent.click(screen.getByLabelText(/clean up/i))
    fireEvent.click(screen.getByLabelText(/translate/i))
    fireEvent.click(screen.getByRole('button', { name: /process book/i }))
    const calls = (onProcess as unknown as { mock: { calls: Array<[TransformOp[]]> } }).mock.calls
    const ops = calls[0]?.[0]
    expect(ops?.map((o: TransformOp) => o.kind)).toEqual(['cleanup', 'translate', 'simplify'])
  })

  it('Cancel calls onCancel', () => {
    const { onCancel } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('renders a progressbar with the stage while running', () => {
    renderModal({ state: { type: 'running', fraction: 0.5, stage: 'Translate (1/2)' } })
    expect(screen.getByText(/Translate \(1\/2\)/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    // Process button hidden while running; Cancel remains
    expect(screen.queryByRole('button', { name: /process book/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel transform/i })).toBeInTheDocument()
  })

  it('renders the done message and hides Process when done', () => {
    renderModal({
      state: { type: 'done', message: 'Transform applied — resumed at start of chapter 1.' },
    })
    expect(screen.getByText(/resumed at start of chapter 1/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /process book/i })).not.toBeInTheDocument()
  })

  it('renders the error message (and allows retry)', () => {
    renderModal({ state: { type: 'error', message: 'No API key set.' } })
    expect(screen.getByText(/no api key set/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /process book/i })).toBeInTheDocument()
  })
})
