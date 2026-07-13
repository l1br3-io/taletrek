import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Nav } from './Nav'

describe('Nav', () => {
  it('renders links to all routes in the mobile drawer once opened', () => {
    render(
      <MemoryRouter>
        <Nav />
      </MemoryRouter>,
    )
    // Desktop links are hidden below `sm`; open the mobile drawer.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }))
    const drawer = screen.getByRole('navigation', { name: 'Mobile navigation' })
    expect(within(drawer).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
    expect(within(drawer).getByRole('link', { name: 'Library' })).toHaveAttribute(
      'href',
      '/library',
    )
    expect(within(drawer).getByRole('link', { name: 'Reader' })).toHaveAttribute('href', '/reader')
    expect(within(drawer).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    )
  })

  it('toggles the drawer via the hamburger button', () => {
    render(
      <MemoryRouter>
        <Nav />
      </MemoryRouter>,
    )
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
})
