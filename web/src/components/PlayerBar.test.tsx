import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PlaybackStatus } from '../hooks/useParagraphPlayer'
import { PlayerBar } from './PlayerBar'

function renderBar(overrides?: Partial<React.ComponentProps<typeof PlayerBar>>) {
  const handlers = {
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onStop: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onRateChange: vi.fn(),
  }
  const props = {
    status: { type: 'idle' } as PlaybackStatus,
    playbackRate: 1,
    ...handlers,
    ...overrides,
  }
  const result = render(<PlayerBar {...props} />)
  return { ...result, ...handlers }
}

describe('PlayerBar', () => {
  it('shows a Play button when idle and calls onPlay', () => {
    const { onPlay } = renderBar({ status: { type: 'idle' } })
    const btn = screen.getByRole('button', { name: 'Play' })
    fireEvent.click(btn)
    expect(onPlay).toHaveBeenCalledOnce()
  })

  it('shows a Pause button when playing and calls onPause', () => {
    const { onPause } = renderBar({ status: { type: 'playing', paragraphId: 'c:0' } })
    const btn = screen.getByRole('button', { name: 'Pause' })
    fireEvent.click(btn)
    expect(onPause).toHaveBeenCalledOnce()
  })

  it('disables prev/next/play while loading', () => {
    renderBar({ status: { type: 'loading' } })
    expect(screen.getByRole('button', { name: 'Previous paragraph' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next paragraph' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })

  it('shows the synthesizing label while loading', () => {
    renderBar({ status: { type: 'loading' } })
    expect(screen.getByText('Synthesizing…')).toBeInTheDocument()
  })

  it('shows the error message in the status label', () => {
    renderBar({ status: { type: 'error', message: 'model missing' } })
    expect(screen.getByText('model missing')).toBeInTheDocument()
  })

  it('calls onRateChange when the speed select changes', () => {
    const { onRateChange } = renderBar({ playbackRate: 1 })
    const select = screen.getByDisplayValue('1×')
    fireEvent.change(select, { target: { value: '1.5' } })
    expect(onRateChange).toHaveBeenCalledWith(1.5)
  })

  it('calls prev/next/stop buttons', () => {
    const { onPrev, onNext, onStop } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Previous paragraph' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next paragraph' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onPrev).toHaveBeenCalledOnce()
    expect(onNext).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('renders chapter-skip buttons when handlers are provided', () => {
    const onNextChapter = vi.fn()
    const onPrevChapter = vi.fn()
    renderBar({ onNextChapter, onPrevChapter })
    fireEvent.click(screen.getByRole('button', { name: 'Next chapter' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous chapter' }))
    expect(onNextChapter).toHaveBeenCalledOnce()
    expect(onPrevChapter).toHaveBeenCalledOnce()
  })

  it('omits chapter-skip buttons when no handlers are given', () => {
    renderBar()
    expect(screen.queryByRole('button', { name: 'Next chapter' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Previous chapter' })).toBeNull()
  })

  it('shows a buffering hint while playing with nothing buffered ahead', () => {
    renderBar({ status: { type: 'playing', paragraphId: 'c:0' }, bufferedAhead: 0 })
    expect(screen.getByText(/buffering/)).toBeInTheDocument()
  })

  it('shows plain Playing when a chunk is buffered ahead', () => {
    renderBar({ status: { type: 'playing', paragraphId: 'c:0' }, bufferedAhead: 2 })
    expect(screen.queryByText(/buffering/)).toBeNull()
  })
})
