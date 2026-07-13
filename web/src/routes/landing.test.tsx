import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { GITHUB_URL } from '../lib/site'
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
    const links = screen.getAllByRole('link', { name: /Open your library/i })
    expect(links.length).toBeGreaterThanOrEqual(1)
    for (const link of links) expect(link).toHaveAttribute('href', '/library')
  })

  it('links to the source on GitHub', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    )
    const github = screen.getByRole('link', { name: /GitHub/i })
    expect(github).toHaveAttribute('href', GITHUB_URL)
    expect(github).toHaveAttribute('target', '_blank')
  })
})
