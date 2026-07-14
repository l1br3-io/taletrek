import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BookCover, coverInitials } from './BookCover'

describe('coverInitials', () => {
  it('uses the first letters of the first two words', () => {
    expect(coverInitials('The Lord of the Rings')).toBe('TL')
    expect(coverInitials('Moby Dick')).toBe('MD')
  })

  it('takes the first two chars of a single-word title', () => {
    expect(coverInitials('Dune')).toBe('DU')
    expect(coverInitials('1984')).toBe('19')
  })

  it('handles whitespace and empty input', () => {
    expect(coverInitials('   ')).toBe('?')
    expect(coverInitials('')).toBe('?')
  })

  it('uppercases the initials', () => {
    expect(coverInitials('good omens')).toBe('GO')
  })
})

describe('BookCover', () => {
  it('renders the derived initials', () => {
    render(<BookCover title="The Hobbit" />)
    expect(screen.getByText('TH')).toBeInTheDocument()
  })

  it('is deterministic for the same title (stable gradient pick)', () => {
    const { container, unmount } = render(<BookCover title="Dune" />)
    const cls = container.querySelector('.aspect-\\[3\\/4\\]')?.className ?? ''
    unmount()
    const { container: again } = render(<BookCover title="Dune" />)
    const cls2 = again.querySelector('.aspect-\\[3\\/4\\]')?.className ?? ''
    expect(cls).toBe(cls2)
  })
})
