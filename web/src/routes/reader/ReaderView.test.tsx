import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type Book, bookId, type Chapter, chapterId } from '../../types'
import { ReaderView } from './ReaderView'

const book: Book = {
  id: bookId('b1'),
  title: 'My Book',
  format: 'txt',
  chapterCount: 1,
  createdAt: 1,
  updatedAt: 1,
}

function chapter(paragraphs: string[]): Chapter {
  return {
    id: chapterId('c1'),
    bookId: book.id,
    index: 0,
    title: 'Ch1',
    paragraphs,
  }
}

describe('ReaderView', () => {
  it('renders the book title and paragraphs', () => {
    render(<ReaderView book={book} chapters={[chapter(['Hello.', 'World.'])]} />)
    expect(screen.getByText('My Book')).toBeInTheDocument()
    expect(screen.getByText('Hello.')).toBeInTheDocument()
    expect(screen.getByText('World.')).toBeInTheDocument()
  })

  it('highlights the current paragraph', () => {
    const { container } = render(
      <ReaderView
        book={book}
        chapters={[chapter(['First.', 'Second.'])]}
        currentParagraphId={`${chapterId('c1')}:1`}
      />,
    )
    const paragraphs = container.querySelectorAll('.tt-reader-text p')
    expect(paragraphs[0]?.className).not.toMatch(/accent/)
    expect(paragraphs[1]?.className).toMatch(/accent/)
  })

  it('calls onSeekParagraph with the paragraph id on click', () => {
    const onSeek = vi.fn()
    render(<ReaderView book={book} chapters={[chapter(['Tap me.'])]} onSeekParagraph={onSeek} />)
    fireEvent.click(screen.getByText('Tap me.'))
    expect(onSeek).toHaveBeenCalledWith(`${chapterId('c1')}:0`)
  })

  it('does not attach click handlers when onSeekParagraph is absent', () => {
    const { container } = render(<ReaderView book={book} chapters={[chapter(['No click.'])]} />)
    const p = container.querySelector('.tt-reader-text p')
    expect(p?.className).not.toMatch(/cursor/)
  })

  it('attaches activeParagraphRef to the active paragraph', () => {
    const ref = createRef<HTMLParagraphElement>()
    render(
      <ReaderView
        book={book}
        chapters={[chapter(['First.', 'Second.'])]}
        currentParagraphId={`${chapterId('c1')}:1`}
        activeParagraphRef={ref}
      />,
    )
    expect(ref.current?.textContent).toBe('Second.')
  })

  it('applies the pulse class to the pulsed paragraph', () => {
    const { container } = render(
      <ReaderView
        book={book}
        chapters={[chapter(['First.', 'Second.'])]}
        pulseParagraphId={`${chapterId('c1')}:1`}
      />,
    )
    const paragraphs = container.querySelectorAll('.tt-reader-text p')
    expect(paragraphs[1]?.className).toMatch(/tt-nav-target/)
    expect(paragraphs[0]?.className).not.toMatch(/tt-nav-target/)
  })

  it('renders a subtle dot only for cached paragraphs', () => {
    const ch = chapter(['Ready.', 'Pending.'])
    const { container } = render(
      <ReaderView book={book} chapters={[ch]} bufferedParagraphIds={new Set([`${ch.id}:0`])} />,
    )
    const dots = container.querySelectorAll('.tt-reader-text p span[aria-hidden]')
    // Only the cached paragraph (index 0) gets a dot.
    expect(dots).toHaveLength(1)
    expect(dots[0]?.className).toMatch(/bg-accent/)
  })

  it('renders dots for all cached paragraphs', () => {
    const ch = chapter(['First.', 'Second.'])
    const { container } = render(
      <ReaderView
        book={book}
        chapters={[ch]}
        bufferedParagraphIds={new Set([`${ch.id}:0`, `${ch.id}:1`])}
      />,
    )
    const dots = container.querySelectorAll('.tt-reader-text p span[aria-hidden]')
    expect(dots).toHaveLength(2)
  })

  it('does not render dots when the cache set is empty', () => {
    const { container } = render(
      <ReaderView book={book} chapters={[chapter(['Hello.'])]} bufferedParagraphIds={new Set()} />,
    )
    const dots = container.querySelectorAll('.tt-reader-text p span[aria-hidden]')
    expect(dots).toHaveLength(0)
  })

  it('does not render buffer dots when bufferedParagraphIds is undefined', () => {
    const { container } = render(<ReaderView book={book} chapters={[chapter(['Hello.'])]} />)
    const dots = container.querySelectorAll('.tt-reader-text p span[aria-hidden]')
    expect(dots).toHaveLength(0)
  })

  describe('AI streaming', () => {
    it('renders the streaming chip + cursor + .tt-streaming on the streaming paragraph', () => {
      const ch = chapter(['First.', 'Second.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch]}
          stream={{
            paragraphId: `${ch.id}:1`,
            opLabel: 'Simplify',
            streamingText: 'Second paragraph, simplified so far',
          }}
          onStopStream={() => {}}
        />,
      )
      // The chip is present with the op label and a Stop button.
      const chip = screen.getByTestId('stream-chip')
      expect(chip).toHaveTextContent('❯Simplify')
      expect(screen.getByRole('button', { name: 'Stop Simplify' })).toBeInTheDocument()

      // The streaming paragraph carries the .tt-streaming marker.
      const paragraphs = container.querySelectorAll('.tt-reader-text p')
      expect(paragraphs[0]?.className).not.toMatch(/tt-streaming/)
      expect(paragraphs[1]?.className).toMatch(/tt-streaming/)

      // The streaming paragraph shows the streamed text + a blinking cursor (█).
      expect(paragraphs[1]?.textContent).toContain('Second paragraph, simplified so far')
      expect(paragraphs[1]?.textContent).toContain('█')
    })

    it('renders the original text + no chip when stream is null', () => {
      const { container } = render(
        <ReaderView book={book} chapters={[chapter(['Hello.'])]} stream={null} />,
      )
      expect(screen.queryByTestId('stream-chip')).not.toBeInTheDocument()
      const p = container.querySelector('.tt-reader-text p')
      expect(p?.textContent).toBe('Hello.')
      expect(p?.className).not.toMatch(/tt-streaming/)
    })

    it('yields active + seekable states while a paragraph is streaming', () => {
      const onSeek = vi.fn()
      const ch = chapter(['Active.', 'Streaming.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch]}
          currentParagraphId={`${ch.id}:1`} // would normally be active
          onSeekParagraph={onSeek}
          stream={{
            paragraphId: `${ch.id}:1`, // same paragraph — streaming wins
            opLabel: 'Translate',
            streamingText: 'Translated text',
          }}
        />,
      )
      const paragraphs = container.querySelectorAll('.tt-reader-text p')
      // Paragraph 1 is streaming — should NOT carry the active highlight.
      expect(paragraphs[1]?.className).not.toMatch(/bg-accent-soft|ring-accent/)
      expect(paragraphs[1]?.className).toMatch(/tt-streaming/)
      // Paragraph 1 is NOT seekable while streaming (no role=button).
      expect(paragraphs[1]?.getAttribute('role')).toBeNull()
    })

    it('calls onStopStream when the Stop button is clicked', () => {
      const onStop = vi.fn()
      const ch = chapter(['Hello.'])
      render(
        <ReaderView
          book={book}
          chapters={[ch]}
          stream={{ paragraphId: `${ch.id}:0`, opLabel: 'Simplify', streamingText: 'Hi' }}
          onStopStream={onStop}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Stop Simplify' }))
      expect(onStop).toHaveBeenCalledTimes(1)
    })

    it('sets aria-live="off" on the streaming paragraph (SR announce via status region, not per-token)', () => {
      const ch = chapter(['Hello.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch]}
          stream={{ paragraphId: `${ch.id}:0`, opLabel: 'Simplify', streamingText: 'Hi' }}
        />,
      )
      const p = container.querySelector('.tt-reader-text p')
      expect(p?.getAttribute('aria-live')).toBe('off')
      // Status region is present and announces the op start.
      expect(screen.getByTestId('stream-status')).toHaveTextContent('Simplify started')
    })
  })

  describe('M13 whole-book generation mode', () => {
    it('renders in-place streaming paragraphs (preserve mode): new text in streamed slots, old text dimmed beyond', () => {
      // Chapter has 3 paragraphs. Streaming has produced 2 so far (the
      // second is in-progress). chunkInputCount=3 means the chunk covers
      // the whole chapter. Preserve mode (non-reductive) keeps the slot
      // count stable.
      const ch1 = chapter(['Committed one.'])
      const ch2 = chapter(['Original A.', 'Original B.', 'Original C.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch1, ch2]}
          generation={{
            activeChapterIndex: 1,
            chapterStartedAt: 0,
            opLabel: 'cleanup',
            running: true,
            streamingParagraphs: {
              opLabel: 'cleanup',
              isReductive: false,
              chunkStartIndex: 0,
              chunkInputCount: 3,
              chunkIndex: 0,
              chunkTotal: 1,
              paragraphs: ['Cleaned A.', 'Cleaned B (in progress'],
              reasoning: '',
            },
          }}
        />,
      )
      // Status region announces generation.
      expect(screen.getByTestId('stream-status')).toHaveTextContent('cleanup started')
      const sections = container.querySelectorAll('section')
      expect(sections).toHaveLength(2)
      // Chapter 1 (before active) renders normally.
      expect(sections[0]?.getAttribute('data-pending')).toBeNull()
      // Active chapter: 3 paragraph slots total.
      const activeParas = sections[1]?.querySelectorAll('.tt-reader-text p')
      expect(activeParas).toHaveLength(3)
      // Slot 0: cleaned text, no cursor.
      expect(activeParas?.[0]).toHaveTextContent('Cleaned A.')
      expect(activeParas?.[0]?.getAttribute('data-streaming')).toBeNull()
      expect(activeParas?.[0]?.getAttribute('data-dimmed')).toBeNull()
      // Slot 1: in-progress streaming text + cursor.
      expect(activeParas?.[1]).toHaveTextContent('Cleaned B (in progress')
      expect(activeParas?.[1]?.getAttribute('data-streaming')).toBe('true')
      expect(activeParas?.[1]?.textContent).toContain('█')
      // Slot 2: old text, dimmed (not yet streamed).
      expect(activeParas?.[2]).toHaveTextContent('Original C.')
      expect(activeParas?.[2]?.getAttribute('data-dimmed')).toBe('true')
      expect(activeParas?.[2]?.getAttribute('data-streaming')).toBeNull()
    })

    it('renders in-place streaming paragraphs (replace mode): old paragraphs vanish, new grow with cursor on last', () => {
      // Reductive op (summarize). Chapter has 3 paragraphs; summarize stream
      // has produced 2 new ones so far. Old paragraphs should NOT render.
      const ch = chapter(['Old paragraph one.', 'Old paragraph two.', 'Old paragraph three.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch]}
          generation={{
            activeChapterIndex: 0,
            chapterStartedAt: 0,
            opLabel: 'summarize',
            running: true,
            streamingParagraphs: {
              opLabel: 'summarize',
              isReductive: true,
              chunkStartIndex: 0,
              chunkInputCount: 3,
              chunkIndex: 0,
              chunkTotal: 1,
              paragraphs: ['Summary paragraph one.', 'Summary paragraph two (in progress'],
              reasoning: '',
            },
          }}
        />,
      )
      const paras = container.querySelectorAll('.tt-reader-text p')
      // Only the streaming paragraphs render — original 3 are hidden.
      expect(paras).toHaveLength(2)
      expect(paras[0]).toHaveTextContent('Summary paragraph one.')
      expect(paras[0]?.getAttribute('data-streaming')).toBeNull()
      expect(paras[1]).toHaveTextContent('Summary paragraph two (in progress')
      expect(paras[1]?.getAttribute('data-streaming')).toBe('true')
      expect(paras[1]?.textContent).toContain('█')
      // None of the old text leaks through.
      expect(container.textContent).not.toContain('Old paragraph one')
    })

    it('replace mode shows a placeholder before the first token arrives', () => {
      const ch = chapter(['Old paragraph.'])
      render(
        <ReaderView
          book={book}
          chapters={[ch]}
          generation={{
            activeChapterIndex: 0,
            chapterStartedAt: 0,
            opLabel: 'summarize',
            running: true,
            streamingParagraphs: {
              opLabel: 'summarize',
              isReductive: true,
              chunkStartIndex: 0,
              chunkInputCount: 1,
              chunkIndex: 0,
              chunkTotal: 1,
              paragraphs: [],
              reasoning: '',
            },
          }}
        />,
      )
      // Placeholder paragraph is present with streaming cursor — old text hidden.
      const paras = screen.getAllByTestId('stream-status', { exact: false })
      expect(paras.length).toBeGreaterThan(0)
      const streamingP = document.querySelector('.tt-reader-text p[data-streaming="true"]')
      expect(streamingP).not.toBeNull()
    })

    it('applies a "pending" wash (opacity) to chapters after the active one', () => {
      const ch1 = chapter(['Active.'])
      const ch2 = chapter(['Pending.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch1, ch2]}
          generation={{
            activeChapterIndex: 0,
            chapterStartedAt: 0,
            opLabel: 'cleanup',
            running: true,
            streamingParagraphs: null,
          }}
        />,
      )
      const sections = container.querySelectorAll('section')
      expect(sections[0]?.getAttribute('data-pending')).toBeNull()
      expect(sections[1]?.getAttribute('data-pending')).toBe('true')
    })

    it('shows the inline preparing chip when active chapter has no streamingParagraphs yet (provider latency feedback)', () => {
      // Reproduces the 2026-07-20 regression: z.ai glm-4.7 took 268s for the
      // first token. During that gap, the active chapter must visibly
      // communicate "preparing" — otherwise the user assumes the app is
      // hung and cancels.
      const ch = chapter(['Original paragraph one.', 'Original paragraph two.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch]}
          generation={{
            activeChapterIndex: 0,
            chapterStartedAt: 0,
            opLabel: 'TAE',
            running: true,
            streamingParagraphs: null,
          }}
        />,
      )
      const chip = screen.getByTestId('chapter-preparing-chip')
      expect(chip).toHaveTextContent('TAE')
      expect(chip).toHaveTextContent('preparing chapter')
      // Elapsed timer is present (testid on the inner span).
      expect(chip.querySelector('[data-testid="preparing-elapsed"]')).not.toBeNull()
      // Old paragraphs still render (visible, not streaming, not dimmed).
      const paras = container.querySelectorAll('.tt-reader-text p')
      expect(paras).toHaveLength(2)
      expect(paras[0]).toHaveTextContent('Original paragraph one.')
      expect(paras[0]?.getAttribute('data-streaming')).toBeNull()
      expect(paras[0]?.getAttribute('data-dimmed')).toBeNull()
    })

    it('hides the preparing chip once streamingParagraphs becomes non-null (tokens flowing)', () => {
      const ch = chapter(['Original.'])
      render(
        <ReaderView
          book={book}
          chapters={[ch]}
          generation={{
            activeChapterIndex: 0,
            chapterStartedAt: 0,
            opLabel: 'cleanup',
            running: true,
            streamingParagraphs: {
              opLabel: 'cleanup',
              isReductive: false,
              chunkStartIndex: 0,
              chunkInputCount: 1,
              chunkIndex: 0,
              chunkTotal: 1,
              paragraphs: ['Cleaned.'],
              reasoning: '',
            },
          }}
        />,
      )
      // Once streaming has begun, the preparing chip is gone.
      expect(screen.queryByTestId('chapter-preparing-chip')).toBeNull()
    })

    it('shows live reasoning snippet in the preparing chip (reasoning-model support)', () => {
      // Reproduces the 2026-07-20 finding: glm-5.2 (reasoning model) takes
      // 30s+ to emit visible content, but streams `reasoning_content` tokens
      // during the wait. Without surfacing those, the user stares at an
      // opaque "preparing chapter" with no feedback.
      const ch = chapter(['Original paragraph one.', 'Original paragraph two.'])
      render(
        <ReaderView
          book={book}
          chapters={[ch]}
          generation={{
            activeChapterIndex: 0,
            chapterStartedAt: 0,
            opLabel: 'TAE',
            running: true,
            streamingParagraphs: {
              opLabel: 'TAE',
              isReductive: false,
              chunkStartIndex: 0,
              chunkInputCount: 2,
              chunkIndex: 0,
              chunkTotal: 1,
              paragraphs: [], // No content yet — still preparing
              reasoning:
                'Let me analyze the tone of these paragraphs. I see formal language, so I should preserve register while cleaning up…',
            },
          }}
        />,
      )
      const chip = screen.getByTestId('chapter-preparing-chip')
      // Chip is still in "thinking" mode (not "preparing chapter").
      expect(chip).toHaveTextContent('thinking')
      // Reasoning snippet is rendered (most recent slice).
      const reasoning = screen.getByTestId('preparing-reasoning')
      expect(reasoning.textContent).toContain('analyze the tone')
    })

    it('disables seek (no role=button) on paragraphs while generation is active', () => {
      const ch = chapter(['One.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch]}
          onSeekParagraph={() => {}}
          generation={{
            activeChapterIndex: 0,
            chapterStartedAt: 0,
            opLabel: 'cleanup',
            running: true,
            streamingParagraphs: null,
          }}
        />,
      )
      const p = container.querySelector('.tt-reader-text p')
      // Even with onSeekParagraph provided, generation disables seek.
      expect(p?.getAttribute('role')).toBeNull()
    })

    it('disables seek on paragraphs while synthLockdown is active (FFmpeg-during-synth gate)', () => {
      // Issue #4: mobile FFmpeg users must not be able to click paragraphs
      // and trigger on-demand synth via the desktop fallback. The lockdown
      // is enforced at PlayerBar (transport buttons disabled) AND at the
      // body (no role=button) so the contract is visible.
      const ch = chapter(['Lockdown paragraph.'])
      const { container } = render(
        <ReaderView book={book} chapters={[ch]} onSeekParagraph={() => {}} synthLockdown />,
      )
      const p = container.querySelector('.tt-reader-text p')
      expect(p?.getAttribute('role')).toBeNull()
    })

    it('renders chapters normally when streamingParagraphs is null (between chunks or pre-first-token for non-reductive)', () => {
      const ch = chapter(['Original.'])
      const { container } = render(
        <ReaderView
          book={book}
          chapters={[ch]}
          generation={{
            activeChapterIndex: 0,
            chapterStartedAt: 0,
            opLabel: 'cleanup',
            running: true,
            streamingParagraphs: null,
          }}
        />,
      )
      // No streaming paragraphs → existing chapter text renders normally.
      const p = container.querySelector('.tt-reader-text p')
      expect(p).toHaveTextContent('Original.')
      expect(p?.getAttribute('data-streaming')).toBeNull()
    })

    it('renders normally when generation is null', () => {
      const ch = chapter(['Hello.'])
      const { container } = render(
        <ReaderView book={book} chapters={[ch]} onSeekParagraph={() => {}} />,
      )
      const p = container.querySelector('.tt-reader-text p')
      expect(p?.getAttribute('role')).toBe('button')
      // No streaming visual.
      expect(container.querySelector('[data-streaming="true"]')).toBeNull()
    })
  })
})
