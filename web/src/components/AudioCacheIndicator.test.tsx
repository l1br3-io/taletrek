import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AudioCacheIndicator } from './AudioCacheIndicator'

describe('AudioCacheIndicator', () => {
  it('renders a loading label while sizeBytes is null', () => {
    render(<AudioCacheIndicator sizeBytes={null} onClear={vi.fn()} />)
    expect(screen.getByText(/Cached audio: …/)).toBeInTheDocument()
  })

  it('renders the current size and budget when sizeBytes is a number', () => {
    render(<AudioCacheIndicator sizeBytes={412 * 1024 * 1024} onClear={vi.fn()} />)
    expect(screen.getByText(/Cached audio: 412 MB \/ 500 MB/)).toBeInTheDocument()
  })

  it('renders 0 MB when the cache is empty', () => {
    render(<AudioCacheIndicator sizeBytes={0} onClear={vi.fn()} />)
    expect(screen.getByText(/Cached audio: 0 MB \/ 500 MB/)).toBeInTheDocument()
  })

  it('calls onClear when the Clear button is clicked', () => {
    const onClear = vi.fn()
    render(<AudioCacheIndicator sizeBytes={1024} onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(onClear).toHaveBeenCalledOnce()
  })

  it('disables Clear when clearing is true', () => {
    render(<AudioCacheIndicator sizeBytes={1024} onClear={vi.fn()} clearing />)
    expect(screen.getByRole('button', { name: /Clearing…/ })).toBeDisabled()
  })

  it('disables Clear when the cache is empty', () => {
    render(<AudioCacheIndicator sizeBytes={0} onClear={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Clear/ })).toBeDisabled()
  })
})
