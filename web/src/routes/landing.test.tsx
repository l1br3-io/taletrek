import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Landing } from './landing'

describe('Landing', () => {
  it('renders the tagline', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    )
    expect(
      screen.getByText((_, node) => node?.textContent === 'Every story is a journey.'),
    ).toBeInTheDocument()
  })

  it('mentions the l1br3 org', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    )
    expect(screen.getByText('l1br3', { exact: false })).toBeInTheDocument()
  })

  it('offers an upload call to action', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /Upload a book/i })).toHaveAttribute('href', '/reader')
  })
})
