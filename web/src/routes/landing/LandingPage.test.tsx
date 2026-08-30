import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { GITHUB_URL } from '../../lib/site'
import { Landing } from './LandingPage'

function renderLanding() {
  render(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>,
  )
}

describe('Landing', () => {
  it('renders the tagline', () => {
    renderLanding()
    expect(
      screen.getByText((_, node) => node?.textContent === 'Every story is a journey.'),
    ).toBeInTheDocument()
  })

  it('mentions the l1br3 org', () => {
    renderLanding()
    const marks = screen.getAllByText('l1br3', { exact: false })
    expect(marks.length).toBeGreaterThanOrEqual(1)
  })

  it('offers a library call to action', () => {
    renderLanding()
    const links = screen.getAllByRole('link', { name: /Open your library/i })
    expect(links.length).toBeGreaterThanOrEqual(1)
    for (const link of links) expect(link).toHaveAttribute('href', '/library')
  })

  it('links to the source on GitHub', () => {
    renderLanding()
    const github = screen.getByRole('link', { name: /GitHub/i })
    expect(github).toHaveAttribute('href', GITHUB_URL)
    expect(github).toHaveAttribute('target', '_blank')
  })

  it('makes no browser-platform claims (the pipeline is native now)', () => {
    renderLanding()
    expect(screen.queryByText(/in your browser/i)).toBeNull()
    expect(screen.queryByText(/no app store/i)).toBeNull()
    expect(screen.queryByText(/install taletrek as a pwa/i)).toBeNull()
  })

  it('lists the apps with desktop as the first ship and mobile coming soon', () => {
    renderLanding()
    const desktop = screen.getByRole('heading', { name: 'Desktop' })
    const android = screen.getByRole('heading', { name: 'Android' })
    const ios = screen.getByRole('heading', { name: 'iOS' })
    expect(desktop).toBeInTheDocument()
    expect(android).toBeInTheDocument()
    expect(ios).toBeInTheDocument()
    expect(desktop.compareDocumentPosition(android) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(android.compareDocumentPosition(ios) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByText(/coming soon/i).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/first ship|in development/i)).toBeInTheDocument()
  })

  it('shows the today path: open a .taletrek in the reader, or use the CLI', () => {
    renderLanding()
    expect(screen.getByRole('heading', { name: /open a \.?taletrek/i })).toBeInTheDocument()
    expect(screen.getByText(/just synth/i)).toBeInTheDocument()
  })
})
