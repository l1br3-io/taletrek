import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TransformDefinition, TransformOp } from '../../lib/ai/types'
import { transformDefId } from '../../lib/ai/types'
import { UploadBookModal } from './UploadBookModal'
import type { TransformState } from './useAiTransform'

function makeDefs(): TransformDefinition[] {
  return [
    {
      id: transformDefId('cleanup'),
      label: 'Clean up',
      hint: 'Remove clutter from source text',
      desc: 'Uses AI to clean up OCR artifacts, malformed paragraphs, and other source-text issues.',
      systemPrompt: 'Clean up: {{text}}',
      params: [],
    },
    {
      id: transformDefId('translate'),
      label: 'Translate',
      hint: 'Translate in-place',
      desc: 'BCP-47 code such as es, fr, or de',
      systemPrompt: 'Translate to {{target}}: {{text}}',
      params: [
        { key: 'target', type: 'text' as const, label: 'Target language code', default: 'es' },
      ],
    },
    {
      id: transformDefId('summarize'),
      label: 'Summarize',
      hint: 'Condense paragraphs',
      desc: 'Keeps the gist of each paragraph for easier listening.',
      systemPrompt: 'Summarize to {{fraction}}: {{text}}',
      params: [
        {
          key: 'fraction',
          type: 'range' as const,
          label: 'Summarize to fraction',
          default: 0.5,
          min: 0.1,
          max: 1,
          step: 0.1,
        },
      ],
    },
    {
      id: transformDefId('simplify'),
      label: 'Simplify',
      hint: 'Use simpler words',
      desc: 'Rewrites complex sentences with simpler vocabulary.',
      systemPrompt: 'Simplify: {{text}}',
      params: [],
    },
  ]
}

const cleanupDefId = transformDefId('cleanup')
const translateDefId = transformDefId('translate')
const simplifyDefId = transformDefId('simplify')

function renderModal(
  overrides: {
    state?: TransformState
    onGenerate?: (ops: TransformOp[]) => void
    defs?: TransformDefinition[]
    online?: boolean
  } = {},
) {
  const onGenerate = overrides.onGenerate ?? vi.fn()
  const onCancel = vi.fn()
  render(
    <UploadBookModal
      open
      state={overrides.state ?? { type: 'idle' }}
      onCancel={onCancel}
      onGenerate={onGenerate}
      defs={overrides.defs ?? makeDefs()}
      online={overrides.online ?? true}
    />,
  )
  return { onGenerate, onCancel }
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

  it('Process is disabled until an op is selected, then fires onGenerate with the built ops', () => {
    const { onGenerate } = renderModal()
    const processBtn = screen.getByRole('button', { name: /generate/i })
    expect(processBtn).toBeDisabled()

    fireEvent.click(screen.getByLabelText(/translate/i))
    expect(processBtn).not.toBeDisabled()
    fireEvent.change(screen.getByLabelText(/target language code/i), { target: { value: 'fr' } })
    fireEvent.click(processBtn)

    expect(onGenerate).toHaveBeenCalledWith([
      { defId: translateDefId, params: { target: 'fr' } },
    ] as never)
  })

  it('emits ops in canonical order (cleanup → translate → summarize → simplify)', () => {
    const { onGenerate } = renderModal()
    fireEvent.click(screen.getByLabelText(/simplify/i))
    fireEvent.click(screen.getByLabelText(/clean up/i))
    fireEvent.click(screen.getByLabelText(/translate/i))
    fireEvent.click(screen.getByRole('button', { name: /generate/i }))
    const calls = (onGenerate as unknown as { mock: { calls: Array<[TransformOp[]]> } }).mock.calls
    const ops = calls[0]?.[0]
    expect(ops?.map((o: TransformOp) => o.defId)).toEqual([
      cleanupDefId,
      translateDefId,
      simplifyDefId,
    ])
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
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel transform/i })).toBeInTheDocument()
  })

  it('renders the done message and hides Process when done', () => {
    renderModal({
      state: { type: 'done', message: 'Transform applied — resumed at start of chapter 1.' },
    })
    expect(screen.getByText(/resumed at start of chapter 1/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
  })

  it('renders the error message (and allows retry)', () => {
    renderModal({ state: { type: 'error', message: 'No API key set.' } })
    expect(screen.getByText(/no api key set/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument()
  })
})
