import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TransformState } from '../hooks/useAiTransform'
import type { OutlineState } from '../hooks/useOutline'
import type { TransformOp } from '../lib/ai/types'
import type { BookFormat } from '../types'
import { UploadBookModal } from './UploadBookModal'

function renderModal(
  overrides: {
    state?: TransformState
    onProcess?: (ops: TransformOp[]) => void
    outline?: {
      state: OutlineState
      onGenerate: () => void
      onGenerateAi?: () => void
      format: BookFormat
    }
    online?: boolean
  } = {},
) {
  const onProcess = overrides.onProcess ?? vi.fn()
  const onCancel = vi.fn()
  render(
    <UploadBookModal
      open
      state={overrides.state ?? { type: 'idle' }}
      onCancel={onCancel}
      onProcess={onProcess}
      outline={overrides.outline}
      online={overrides.online ?? true}
    />,
  )
  return { onProcess, onCancel }
}

describe('UploadBookModal', () => {
  it('renders the four transform checkboxes', () => {
    renderModal()
    expect(screen.getByLabelText(/clean up/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/translate/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/summarize/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/simplify/i)).toBeInTheDocument()
  })

  it('renders a longer description and header explainer for each transform', () => {
    renderModal()
    expect(screen.getByText(/Your original file is kept/i)).toBeInTheDocument()
    expect(screen.getByText(/BCP-47 code such as es, fr, or de/i)).toBeInTheDocument()
    expect(screen.getByText(/easier listening/i)).toBeInTheDocument()
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

    expect(onProcess).toHaveBeenCalledWith(
      [{ kind: 'translate', target: 'fr' }] as never,
      undefined,
    )
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
    fireEvent.click(screen.getByRole('button', { name: /skip/i }))
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

describe('UploadBookModal — outline section', () => {
  it('renders the auto-detect button when provided for a non-EPUB book', () => {
    renderModal({
      outline: {
        state: { type: 'idle' },
        onGenerate: vi.fn(),
        format: 'txt',
      },
    })
    expect(screen.getByRole('button', { name: /auto-detect chapters/i })).toBeInTheDocument()
  })

  it('hides the outline section for EPUB books', () => {
    renderModal({
      outline: {
        state: { type: 'idle' },
        onGenerate: vi.fn(),
        format: 'epub',
      },
    })
    expect(screen.queryByRole('button', { name: /auto-detect chapters/i })).not.toBeInTheDocument()
  })

  it('hides the AI button when onGenerateAi is not provided', () => {
    renderModal({
      outline: { state: { type: 'idle' }, onGenerate: vi.fn(), format: 'pdf' },
    })
    expect(
      screen.queryByRole('button', { name: /detect chapters with ai/i }),
    ).not.toBeInTheDocument()
  })

  it('shows the AI button when onGenerateAi is provided', () => {
    renderModal({
      outline: {
        state: { type: 'idle' },
        onGenerate: vi.fn(),
        onGenerateAi: vi.fn(),
        format: 'pdf',
      },
    })
    expect(screen.getByRole('button', { name: /detect chapters with ai/i })).toBeInTheDocument()
  })

  it('calls onGenerate when the Auto-detect button is clicked', () => {
    const onGenerate = vi.fn()
    renderModal({
      outline: { state: { type: 'idle' }, onGenerate, format: 'pdf' },
    })
    fireEvent.click(screen.getByRole('button', { name: /auto-detect chapters/i }))
    expect(onGenerate).toHaveBeenCalledOnce()
  })

  it('calls onGenerateAi when the AI button is clicked', () => {
    const onGenerateAi = vi.fn()
    renderModal({
      outline: { state: { type: 'idle' }, onGenerate: vi.fn(), onGenerateAi, format: 'pdf' },
    })
    fireEvent.click(screen.getByRole('button', { name: /detect chapters with ai/i }))
    expect(onGenerateAi).toHaveBeenCalledOnce()
  })

  it('shows the done message when outline state is done', () => {
    renderModal({
      outline: {
        state: { type: 'done', message: 'Outline generated — 5 chapters detected.' },
        onGenerate: vi.fn(),
        format: 'txt',
      },
    })
    expect(screen.getByText(/5 chapters detected/)).toBeInTheDocument()
  })

  it('hides buttons while transforms are running', () => {
    renderModal({
      state: { type: 'running', fraction: 0.5, stage: 'Clean up (1/1)' },
      outline: { state: { type: 'idle' }, onGenerate: vi.fn(), format: 'txt' },
    })
    expect(screen.queryByRole('button', { name: /auto-detect chapters/i })).not.toBeInTheDocument()
  })

  it('hides the Process button while outline is running', () => {
    renderModal({
      outline: { state: { type: 'running' }, onGenerate: vi.fn(), format: 'txt' },
    })
    expect(screen.queryByRole('button', { name: /process book/i })).not.toBeInTheDocument()
  })
})

describe('UploadBookModal — offline', () => {
  it('disables transform checkboxes when offline', () => {
    renderModal({ online: false })
    expect(screen.getByLabelText(/clean up/i)).toBeDisabled()
    expect(screen.getByLabelText(/translate/i)).toBeDisabled()
  })

  it('disables the Process button when offline', () => {
    renderModal({ online: false })
    expect(screen.getByRole('button', { name: /process book/i })).toBeDisabled()
  })

  it('shows an offline info message when offline', () => {
    renderModal({ online: false })
    const banner = document.querySelector('.text-amber-600')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('require an internet connection')
  })

  it('disables the AI outline button when offline', () => {
    renderModal({
      online: false,
      outline: {
        state: { type: 'idle' },
        onGenerate: vi.fn(),
        onGenerateAi: vi.fn(),
        format: 'pdf',
      },
    })
    expect(screen.getByRole('button', { name: /detect chapters with ai/i })).toBeDisabled()
  })

  it('leaves the pattern-based Auto-detect enabled when offline', () => {
    renderModal({
      online: false,
      outline: {
        state: { type: 'idle' },
        onGenerate: vi.fn(),
        format: 'pdf',
      },
    })
    expect(screen.getByRole('button', { name: /auto-detect chapters/i })).not.toBeDisabled()
  })
})
