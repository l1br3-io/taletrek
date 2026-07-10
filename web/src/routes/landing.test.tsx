import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Landing } from './landing'

describe('Landing', () => {
  it('renders the tagline', () => {
    render(<Landing />)
    expect(
      screen.getByText((_, node) => node?.textContent === 'Every story is a journey.'),
    ).toBeInTheDocument()
  })

  it('mentions the l1br3 org', () => {
    render(<Landing />)
    expect(screen.getByText('l1br3', { exact: false })).toBeInTheDocument()
  })
})
