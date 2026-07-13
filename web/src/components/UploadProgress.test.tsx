import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UploadState } from '../hooks/useBookUpload'
import { UploadProgress } from './UploadProgress'

describe('UploadProgress', () => {
  it('renders nothing when idle', () => {
    const { container } = render(
      <UploadProgress
        state={{ type: 'idle' } as UploadState}
        onStartReading={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the filename and spinner during parsing', () => {
    render(
      <UploadProgress
        state={{ type: 'parsing', fileName: 'book.epub' }}
        onStartReading={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText(/Parsing.*book\.epub/)).toBeInTheDocument()
  })

  it('shows a progress bar and Start reading button during voice download', () => {
    render(
      <UploadProgress
        state={{ type: 'voiceDownload', fileName: 'book.epub', fraction: 0.5 }}
        onStartReading={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText(/Downloading voice/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Start reading/ })).toBeInTheDocument()
  })

  it('shows done/total and Start reading button during synthesis', () => {
    render(
      <UploadProgress
        state={{ type: 'synthesizing', fileName: 'book.epub', done: 5, total: 10 }}
        onStartReading={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText(/Preparing audiobook/)).toBeInTheDocument()
    expect(screen.getByText(/5 \/ 10/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Start reading/ })).toBeInTheDocument()
  })

  it('calls onStartReading when the Start reading button is clicked', () => {
    const onStartReading = vi.fn()
    render(
      <UploadProgress
        state={{ type: 'synthesizing', fileName: 'book.epub', done: 3, total: 10 }}
        onStartReading={onStartReading}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Start reading/ }))
    expect(onStartReading).toHaveBeenCalledOnce()
  })

  it('shows the error message and a dismiss button on error', () => {
    const onDismiss = vi.fn()
    render(
      <UploadProgress
        state={{ type: 'error', message: 'Something went wrong' }}
        onStartReading={vi.fn()}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Dismiss error/ }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
