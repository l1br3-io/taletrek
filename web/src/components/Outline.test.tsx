import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bookId, type Chapter, chapterId } from '../types'
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
