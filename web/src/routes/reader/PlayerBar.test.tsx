import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlayerBar } from './PlayerBar'
import type { PlaybackStatus } from './useParagraphPlayer'

function renderBar(overrides?: Partial<React.ComponentProps<typeof PlayerBar>>) {
  const handlers = {
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onStop: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onRateChange: vi.fn(),
    onGoToCurrent: vi.fn(),
    onOpenOutline: vi.fn(),
    onNextChapter: vi.fn(),
    onPrevChapter: vi.fn(),
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

/** Open the overflow menu so secondary controls render. */
function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More playback controls' }))
}

describe('PlayerBar', () => {
  it('shows a Play button when idle and calls onPlay', () => {
    const { onPlay } = renderBar({ status: { type: 'idle' } })
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(onPlay).toHaveBeenCalledOnce()
  })

  it('shows a Pause button when playing and calls onPause', () => {
    const { onPause } = renderBar({ status: { type: 'playing', paragraphId: 'c:0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(onPause).toHaveBeenCalledOnce()
  })

  it('disables prev/next/play while loading', () => {
    renderBar({ status: { type: 'loading' } })
    expect(screen.getByRole('button', { name: 'Previous paragraph' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next paragraph' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })

  it('shows the synthesizing label in the status text', () => {
    renderBar({ status: { type: 'loading' } })
    expect(screen.getByText('Synthesizing…')).toBeInTheDocument()
  })

  it('shows the error message in the status label', () => {
    renderBar({ status: { type: 'error', message: 'model missing' } })
    expect(screen.getByText('model missing')).toBeInTheDocument()
  })

  it('renders primary prev/next and the overflow button', () => {
    renderBar()
    expect(screen.getByRole('button', { name: 'Previous paragraph' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next paragraph' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More playback controls' })).toBeInTheDocument()
  })

  it('calls onRateChange when the speed select changes (in the menu)', () => {
    const { onRateChange } = renderBar({ playbackRate: 1 })
    openMenu()
    const select = screen.getByDisplayValue('1×')
    fireEvent.change(select, { target: { value: '1.5' } })
    expect(onRateChange).toHaveBeenCalledWith(1.5)
  })

  it('calls prev/next (primary) and stop (menu)', () => {
    const { onPrev, onNext, onStop } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Previous paragraph' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next paragraph' }))
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onPrev).toHaveBeenCalledOnce()
    expect(onNext).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('renders chapter-skip controls inside the overflow menu', () => {
    const onNextChapter = vi.fn()
    const onPrevChapter = vi.fn()
    renderBar({ onNextChapter, onPrevChapter })
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /Next chapter/ }))
    expect(onNextChapter).toHaveBeenCalledOnce()
    // Each selection closes the menu; re-open for the next action.
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /Prev chapter/ }))
    expect(onPrevChapter).toHaveBeenCalledOnce()
  })

  it('omits the overflow button when no secondary handlers are given', () => {
    renderBar({
      onNextChapter: undefined,
      onPrevChapter: undefined,
      onGoToCurrent: undefined,
      onOpenOutline: undefined,
    })
    expect(screen.queryByRole('button', { name: 'More playback controls' })).toBeNull()
  })

  it('calls onGoToCurrent when a current paragraph exists', () => {
    const { onGoToCurrent } = renderBar({ hasCurrentParagraph: true })
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /Go to current paragraph/ }))
    expect(onGoToCurrent).toHaveBeenCalledOnce()
  })

  it('disables go-to-current when there is no current paragraph', () => {
    renderBar({ hasCurrentParagraph: false })
    openMenu()
    expect(screen.getByRole('button', { name: /Go to current paragraph/ })).toBeDisabled()
  })

  it('calls onOpenOutline from the overflow menu', () => {
    const { onOpenOutline } = renderBar()
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Outline' }))
    expect(onOpenOutline).toHaveBeenCalledOnce()
  })

  it('calls onScrollToTop from the overflow menu', () => {
    const onScrollToTop = vi.fn()
    renderBar({ onScrollToTop })
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /Back to top/ }))
    expect(onScrollToTop).toHaveBeenCalledOnce()
  })

  it('calls onTransformParagraph from the overflow menu when a paragraph is current', () => {
    const onTransformParagraph = vi.fn()
    renderBar({ onTransformParagraph, hasCurrentParagraph: true })
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /Transform paragraph/i }))
    expect(onTransformParagraph).toHaveBeenCalledOnce()
  })

  it('disables transform paragraph when there is no current paragraph', () => {
    renderBar({ onTransformParagraph: vi.fn(), hasCurrentParagraph: false })
    openMenu()
    expect(screen.getByRole('button', { name: /Transform paragraph/i })).toBeDisabled()
  })

  it('closes the menu on Escape', () => {
    renderBar()
    openMenu()
    expect(screen.getByDisplayValue('1×')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByDisplayValue('1×')).toBeNull()
  })

  it('shows a buffering hint while playing with nothing buffered ahead', () => {
    renderBar({ status: { type: 'playing', paragraphId: 'c:0' }, bufferedAhead: 0 })
    expect(screen.getByText(/buffering/)).toBeInTheDocument()
  })

  it('shows plain Playing when a chunk is buffered ahead', () => {
    renderBar({ status: { type: 'playing', paragraphId: 'c:0' }, bufferedAhead: 2 })
    expect(screen.queryByText(/buffering/)).toBeNull()
  })

  it('shows Buffering… and disables controls during buffering status', () => {
    renderBar({ status: { type: 'buffering' } })
    expect(screen.getByText('Buffering…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous paragraph' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next paragraph' })).toBeDisabled()
  })
})
