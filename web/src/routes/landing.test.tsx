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

  it('offers a library call to action', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /Browse your library/i })).toHaveAttribute(
      'href',
      '/library',
    )
  })

  it('offers a continue-reading shortcut', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /Continue reading/i })).toHaveAttribute(
      'href',
      '/reader',
    )
  })
})
