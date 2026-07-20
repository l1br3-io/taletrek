import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlayerBar } from './PlayerBar'
import type { PlaybackStatus } from './players/types'

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

  describe('synth lockdown (ADR-0010 / M11)', () => {
    it('disables playback controls while locked down', () => {
      renderBar({ synthLockdown: true, lockdownLabel: 'Synthesizing… 12/42' })
      expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Previous paragraph' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Next paragraph' })).toBeDisabled()
    })

    it('shows the lockdown label in the status area', () => {
      renderBar({ synthLockdown: true, lockdownLabel: 'Synthesizing… 12/42' })
      expect(screen.getByText('Synthesizing… 12/42')).toBeInTheDocument()
    })

    it('disables Stop inside the overflow menu while locked down', () => {
      renderBar({ synthLockdown: true })
      openMenu()
      expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
    })

    it('falls back to the normal status label when lockdown is unset', () => {
      renderBar({ status: { type: 'idle' } })
      expect(screen.getByText('Ready')).toBeInTheDocument()
    })
  })

  describe('generation mode (M13 unified bottom bar)', () => {
    function makeRunningState(overrides?: {
      done?: number
      total?: number
      streamingParagraphs?: object | null
    }) {
      return {
        type: 'running' as const,
        bookId: 'b1' as never,
        opLabel: 'cleanup',
        currentOpIndex: 0,
        totalOps: 1,
        currentChapterIndex: 2,
        totalChapters: 12,
        done: overrides?.done ?? 1,
        total: overrides?.total ?? 12,
        chapterStartedAt: performance.now(),
        streamingParagraphs:
          overrides?.streamingParagraphs === undefined
            ? {
                chunkIndex: 0,
                chunkTotal: 2,
                opLabel: 'cleanup',
                isReductive: false,
                chunkStartIndex: 0,
                chunkInputCount: 5,
                paragraphs: ['p1', 'p2'],
                reasoning: '',
              }
            : overrides.streamingParagraphs,
      }
    }

    function renderGeneration(state: object) {
      const onPause = vi.fn()
      const onResume = vi.fn()
      const onCancel = vi.fn()
      const result = renderBar({
        generation: {
          state: state as never,
          totalChapters: 12,
          onPause,
          onResume,
          onCancel,
        },
      })
      return { ...result, onPause, onResume, onCancel }
    }

    it('swaps the body to generation UI and hides playback controls', () => {
      renderGeneration(makeRunningState())
      // No playback transport buttons.
      expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Previous paragraph' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Next paragraph' })).toBeNull()
      // Generation bar is present.
      expect(screen.getByTestId('generation-banner')).toBeInTheDocument()
    })

    it('shows opLabel, chapter X/Y, and percentage while streaming', () => {
      renderGeneration(makeRunningState({ done: 1, total: 12 }))
      expect(screen.getByText('cleanup')).toBeInTheDocument()
      // ch 3/12 (currentChapterIndex=2 → 1-indexed 3) and a percentage.
      expect(screen.getByText(/ch 3\/12/)).toBeInTheDocument()
      expect(screen.getByText(/\d+%/)).toBeInTheDocument()
    })

    it('wires Pause and Cancel buttons', () => {
      const { onPause, onCancel } = renderGeneration(makeRunningState())
      fireEvent.click(screen.getByRole('button', { name: 'Pause generation' }))
      expect(onPause).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }))
      expect(onCancel).toHaveBeenCalledOnce()
    })

    it('shows spinner + elapsed timer during preparing (no tokens yet)', () => {
      renderGeneration(
        makeRunningState({
          streamingParagraphs: { paragraphs: [], chunkInputCount: 5, chunkIndex: 0, chunkTotal: 2 },
        }),
      )
      // The preparing-status region carries the elapsed timer.
      expect(screen.getByTestId('preparing-status')).toBeInTheDocument()
      // No percentage visible during preparing — it would show 0% and look frozen.
      expect(screen.queryByText(/\d+%/)).toBeNull()
    })

    it('renders the full-bleed progress tape', () => {
      // null streamingParagraphs → no intra-chunk adjustment → fraction = 6/12 = 50%.
      renderGeneration(makeRunningState({ done: 6, total: 12, streamingParagraphs: null }))
      const banner = screen.getByTestId('generation-banner')
      // The tape is a thin bar at the bottom of the banner section.
      const tape = banner.querySelector('.h-0\\.5')
      expect(tape).not.toBeNull()
      // Fill width reflects fraction.
      const fill = tape?.firstChild as HTMLElement
      expect(fill?.style.width).toMatch(/50%/)
    })

    it('shows Resume button when paused', () => {
      const { onResume } = renderGeneration({
        type: 'paused',
        bookId: 'b1',
        done: 3,
        total: 12,
        currentOpIndex: 0,
      })
      expect(screen.getByRole('button', { name: 'Resume generation' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Resume generation' }))
      expect(onResume).toHaveBeenCalledOnce()
    })

    it('shows error message + Retry when state is error', () => {
      const { onResume, onCancel } = renderGeneration({
        type: 'error',
        bookId: 'b1',
        message: 'Provider rate-limited',
      })
      expect(screen.getByText(/Provider rate-limited/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(onResume).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))
      expect(onCancel).toHaveBeenCalledOnce()
    })
  })
})
