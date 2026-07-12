import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { HintsScanState } from '../hooks/usePronunciationHints'
import type { PronunciationCandidate } from '../lib/ai/types'
import { PronunciationReview } from './PronunciationReview'

const CANDIDATES: PronunciationCandidate[] = [
  { id: '1', find: 'Siobhan', replace: 'Shi-vawn', confidence: 0.95, category: 'proper-noun' },
  { id: '2', find: 'Nguyen', replace: 'nwen', confidence: 0.6, category: 'proper-noun' },
  {
    id: '3',
    find: 'Dnipropetrovsk',
    replace: 'Dnee-pro-pe-TROVSK',
    confidence: 0.82,
    category: 'foreign',
  },
]

function renderReview(state: HintsScanState, onAccept = vi.fn(), onClose = vi.fn()) {
  return render(
    <PronunciationReview
      open
      state={state}
      bookTitle="Test Book"
      onAccept={onAccept}
      onClose={onClose}
    />,
  )
}

describe('PronunciationReview — loading + error', () => {
  it('renders a loading message while scanning', () => {
    renderReview({ type: 'loading' })
    expect(screen.getByText(/scanning opening chapter/i)).toBeInTheDocument()
  })

  it('renders an error message', () => {
    renderReview({ type: 'error', message: 'WebGPU unavailable' })
    expect(screen.getByText(/WebGPU unavailable/)).toBeInTheDocument()
  })
})

describe('PronunciationReview — ready with candidates', () => {
  const readyState: HintsScanState = { type: 'ready', candidates: CANDIDATES }

  it('renders candidates ranked by confidence descending', () => {
    renderReview(readyState)
    const inputs = screen.getAllByLabelText('word to replace')
    expect(inputs).toHaveLength(3)
    expect(inputs[0]).toHaveValue('Siobhan')
    expect(inputs[1]).toHaveValue('Dnipropetrovsk')
    expect(inputs[2]).toHaveValue('Nguyen')
  })

  it('shows the confidence percentage for each candidate', () => {
    renderReview(readyState)
    expect(screen.getByText('95%')).toBeInTheDocument()
    expect(screen.getByText('82%')).toBeInTheDocument()
    expect(screen.getByText('60%')).toBeInTheDocument()
  })

  it('accepts a single candidate and saves it', () => {
    const onAccept = vi.fn()
    renderReview(readyState, onAccept)
    fireEvent.click(screen.getByRole('checkbox', { name: /accept siobhan/i }))
    fireEvent.click(screen.getByRole('button', { name: /save 1 accepted/i }))
    expect(onAccept).toHaveBeenCalledWith([{ id: '1', find: 'Siobhan', replace: 'Shi-vawn' }])
  })

  it('bulk-accepts all candidates at or above the threshold (80%)', () => {
    const onAccept = vi.fn()
    renderReview(readyState, onAccept)
    fireEvent.click(screen.getByRole('button', { name: /accept high-confidence/i }))
    fireEvent.click(screen.getByRole('button', { name: /save 2 accepted/i }))
    expect(onAccept).toHaveBeenCalledWith([
      { id: '1', find: 'Siobhan', replace: 'Shi-vawn' },
      { id: '3', find: 'Dnipropetrovsk', replace: 'Dnee-pro-pe-TROVSK' },
    ])
  })

  it('lets the user edit find/replace before accepting', () => {
    const onAccept = vi.fn()
    renderReview(readyState, onAccept)
    fireEvent.click(screen.getByRole('checkbox', { name: /accept dnipropetrovsk/i }))

    fireEvent.change(screen.getByDisplayValue('Dnipropetrovsk'), {
      target: { value: 'Dnipro' },
    })
    fireEvent.change(screen.getByDisplayValue('Dnee-pro-pe-TROVSK'), {
      target: { value: 'DNEE-pro' },
    })

    fireEvent.click(screen.getByRole('button', { name: /save 1 accepted/i }))
    expect(onAccept).toHaveBeenCalledWith([{ id: '3', find: 'Dnipro', replace: 'DNEE-pro' }])
  })

  it('omits the Save button when nothing is accepted', () => {
    renderReview(readyState)
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it('calls onClose when Close is clicked', () => {
    const onClose = vi.fn()
    renderReview(readyState, vi.fn(), onClose)
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('PronunciationReview — empty candidates', () => {
  it('shows a "no candidates" message', () => {
    renderReview({ type: 'ready', candidates: [] })
    expect(screen.getByText(/no candidates found/i)).toBeInTheDocument()
  })
})

describe('PronunciationReview — closed', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <PronunciationReview
        open={false}
        state={{ type: 'idle' }}
        bookTitle={null}
        onAccept={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
