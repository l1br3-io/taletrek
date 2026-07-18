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
})
