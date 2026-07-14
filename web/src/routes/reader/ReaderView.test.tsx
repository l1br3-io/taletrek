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
})
