import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bookId, type Chapter, chapterId } from '../../types'
import { Outline } from './Outline'

function chapter(index: number, title: string): Chapter {
  return {
    id: chapterId(`c${index}`),
    bookId: bookId('b1'),
    index,
    title,
    paragraphs: ['x'],
  }
}

const chapters = [chapter(0, 'Intro'), chapter(1, 'Middle'), chapter(2, '')]

describe('Outline', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Outline
        open={false}
        chapters={chapters}
        currentChapterIndex={1}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists chapter titles and falls back to "Chapter N" for empty titles', () => {
    render(
      <Outline
        open
        chapters={chapters}
        currentChapterIndex={1}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Intro')).toBeInTheDocument()
    expect(screen.getByText('Middle')).toBeInTheDocument()
    expect(screen.getByText('Chapter 3')).toBeInTheDocument()
  })

  it('highlights the current chapter', () => {
    render(
      <Outline
        open
        chapters={chapters}
        currentChapterIndex={1}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const active = screen.getByText('Middle').closest('button')
    expect(active?.getAttribute('aria-current')).toBe('true')
    const inactive = screen.getByText('Intro').closest('button')
    expect(inactive?.getAttribute('aria-current')).toBeNull()
  })

  it('calls onSelect with the chapter index and onClose when a chapter is tapped', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <Outline
        open
        chapters={chapters}
        currentChapterIndex={0}
        onSelect={onSelect}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByText('Middle'))
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <Outline
        open
        chapters={chapters}
        currentChapterIndex={0}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    render(
      <Outline
        open
        chapters={chapters}
        currentChapterIndex={0}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByLabelText('Close outline'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('Outline — sub-headings', () => {
  function chapterWithHeadings(
    index: number,
    title: string,
    headings: { paragraphIndex: number; title: string }[],
  ): Chapter {
    return {
      id: chapterId(`c${index}`),
      bookId: bookId('b1'),
      index,
      title,
      paragraphs: ['x'],
      headings,
    }
  }

  it('renders sub-headings as indented items under their chapter', () => {
    const ch = chapterWithHeadings(0, 'Chapter 1', [
      { paragraphIndex: 1, title: 'THE STORM' },
      { paragraphIndex: 3, title: 'THE CALM' },
    ])
    render(
      <Outline open chapters={[ch]} currentChapterIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByText('THE STORM')).toBeInTheDocument()
    expect(screen.getByText('THE CALM')).toBeInTheDocument()
  })

  it('calls onSelect with chapterIndex and paragraphIndex when a sub-heading is tapped', () => {
    const onSelect = vi.fn()
    const ch = chapterWithHeadings(0, 'Chapter 1', [{ paragraphIndex: 2, title: 'A Section' }])
    render(
      <Outline
        open
        chapters={[ch]}
        currentChapterIndex={0}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('A Section'))
    expect(onSelect).toHaveBeenCalledWith(0, 2)
  })

  it('does not render a sub-heading list when headings is undefined', () => {
    const ch: Chapter = {
      id: chapterId('c0'),
      bookId: bookId('b1'),
      index: 0,
      title: 'Chapter 1',
      paragraphs: ['x'],
    }
    render(
      <Outline open chapters={[ch]} currentChapterIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByText('Chapter 1')).toBeInTheDocument()
  })

  it('renders buffer progress bars when bufferedParagraphIds is provided', () => {
    const ch: Chapter = {
      id: chapterId('c0'),
      bookId: bookId('b1'),
      index: 0,
      title: 'Half Done',
      paragraphs: ['A.', 'B.', 'C.', 'D.'],
    }
    const { container } = render(
      <Outline
        open
        chapters={[ch]}
        currentChapterIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        bufferedParagraphIds={new Set([`${ch.id}:0`, `${ch.id}:1`])}
      />,
    )
    // A progress bar div exists inside the chapter <li>.
    const bars = container.querySelectorAll('li div.h-0\\.5')
    expect(bars).toHaveLength(1)
  })

  it('does not render buffer bars when bufferedParagraphIds is undefined', () => {
    const ch: Chapter = {
      id: chapterId('c0'),
      bookId: bookId('b1'),
      index: 0,
      title: 'No Buffer',
      paragraphs: ['A.'],
    }
    const { container } = render(
      <Outline open chapters={[ch]} currentChapterIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    const bars = container.querySelectorAll('li div.h-0\\.5')
    expect(bars).toHaveLength(0)
  })

  it('auto-expands the current chapter on open', () => {
    const ch = chapterWithHeadings(0, 'Chapter 1', [{ paragraphIndex: 1, title: 'A SECTION' }])
    render(
      <Outline open chapters={[ch]} currentChapterIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByText('A SECTION')).toBeInTheDocument()
    expect(screen.getByLabelText('Collapse Chapter 1')).toBeInTheDocument()
  })

  it('expands sub-headings when the chevron of a collapsed chapter is toggled', () => {
    const ch0 = chapter(0, 'Intro')
    const ch1 = chapterWithHeadings(1, 'Middle', [{ paragraphIndex: 1, title: 'THE STORM' }])
    render(
      <Outline
        open
        chapters={[ch0, ch1]}
        currentChapterIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByText('THE STORM')).toBeNull()
    fireEvent.click(screen.getByLabelText('Expand Middle'))
    expect(screen.getByText('THE STORM')).toBeInTheDocument()
    expect(screen.getByLabelText('Collapse Middle')).toBeInTheDocument()
  })

  it('collapses sub-headings when the chevron of an expanded chapter is toggled', () => {
    const ch = chapterWithHeadings(0, 'Chapter 1', [{ paragraphIndex: 1, title: 'A SECTION' }])
    render(
      <Outline open chapters={[ch]} currentChapterIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByLabelText('Collapse Chapter 1'))
    expect(screen.queryByText('A SECTION')).toBeNull()
    expect(screen.getByLabelText('Expand Chapter 1')).toBeInTheDocument()
  })

  it('does not show a chevron for chapters without headings', () => {
    const ch: Chapter = {
      id: chapterId('c0'),
      bookId: bookId('b1'),
      index: 0,
      title: 'Plain',
      paragraphs: ['x'],
    }
    render(
      <Outline open chapters={[ch]} currentChapterIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.queryByLabelText(/^(Expand|Collapse) /)).toBeNull()
  })

  it('navigates to the chapter start (not a sub-heading) when the title is tapped', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const ch = chapterWithHeadings(0, 'Chapter 1', [{ paragraphIndex: 2, title: 'A Section' }])
    render(
      <Outline
        open
        chapters={[ch]}
        currentChapterIndex={0}
        onSelect={onSelect}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByText('Chapter 1'))
    expect(onSelect).toHaveBeenCalledWith(0)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
