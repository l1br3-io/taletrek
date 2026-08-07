import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CorruptBundleError, NoAudioToExportError } from '../lib/bundle/errors'
import { newBookId } from '../types'
import { BundleExportAction } from './BundleExportAction'

const exportBookBundleMock = vi.fn()
const writeBookBundleMock = vi.fn()

vi.mock('../lib/bundle/export', () => ({
  exportBookBundle: (...args: unknown[]) => exportBookBundleMock(...args),
}))

vi.mock('../lib/bundle/writer', () => ({
  writeBookBundle: (...args: unknown[]) => writeBookBundleMock(...args),
}))

const BOOK_ID = newBookId()

/** Minimal bundle shape — only structural; the action just forwards it. */
function makeBundle() {
  return {
    manifest: { book: { title: 'Dune' } },
    chapters: [],
    audio: new Map(),
    meta: {},
  }
}

let capturedDownload = ''
let createObjectURLSpy: ReturnType<typeof vi.spyOn>
let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  exportBookBundleMock.mockReset()
  writeBookBundleMock.mockReset()
  writeBookBundleMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
  capturedDownload = ''
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    capturedDownload = this.download
  })
  createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

describe('BundleExportAction — chooser', () => {
  it('renders the dialog with the book title and both options', () => {
    render(<BundleExportAction bookId={BOOK_ID} title="Dune" onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /export bundle/i })).toBeInTheDocument()
    expect(screen.getByText('Dune')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /text-only/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /full/i })).toBeInTheDocument()
  })
})

describe('BundleExportAction — download path', () => {
  it('text-only choice exports, writes, and downloads a .text.taletrek file', async () => {
    exportBookBundleMock.mockResolvedValue(makeBundle())
    render(<BundleExportAction bookId={BOOK_ID} title="Dune" onClose={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /text-only/i }))
    })

    await waitFor(() => expect(exportBookBundleMock).toHaveBeenCalledWith(BOOK_ID, { full: false }))
    expect(writeBookBundleMock).toHaveBeenCalledTimes(1)
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:test')
    await waitFor(() => expect(capturedDownload).toBe('dune.text.taletrek'))
  })

  it('full choice uses the .full suffix and passes { full: true }', async () => {
    exportBookBundleMock.mockResolvedValue(makeBundle())
    render(<BundleExportAction bookId={BOOK_ID} title="Dune" onClose={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /full/i }))
    })

    await waitFor(() => expect(exportBookBundleMock).toHaveBeenCalledWith(BOOK_ID, { full: true }))
    await waitFor(() => expect(capturedDownload).toBe('dune.full.taletrek'))
  })

  it('slugifies the title in the filename', async () => {
    exportBookBundleMock.mockResolvedValue(makeBundle())
    render(
      <BundleExportAction bookId={BOOK_ID} title="The Hitchhiker's Guide!" onClose={vi.fn()} />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /text-only/i }))
    })

    await waitFor(() => expect(capturedDownload).toBe('the-hitchhiker-s-guide.text.taletrek'))
  })

  it('shows a success message with the downloaded filename', async () => {
    exportBookBundleMock.mockResolvedValue(makeBundle())
    render(<BundleExportAction bookId={BOOK_ID} title="Dune" onClose={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /text-only/i }))
    })

    expect(await screen.findByText(/Downloaded dune\.text\.taletrek/i)).toBeInTheDocument()
  })

  it('shows a busy status while exporting and disables the options', async () => {
    let resolveExport: (v: unknown) => void = () => {}
    exportBookBundleMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolveExport = r
        }),
    )
    render(<BundleExportAction bookId={BOOK_ID} title="Dune" onClose={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /text-only/i }))
    })

    expect(await screen.findByText(/exporting/i)).toBeInTheDocument()
    // Chooser buttons are gone while busy.
    expect(screen.queryByRole('button', { name: /text-only/i })).not.toBeInTheDocument()

    await act(async () => {
      resolveExport(makeBundle())
    })
    await screen.findByText(/Downloaded/)
  })
})

describe('BundleExportAction — errors', () => {
  it('maps NoAudioToExportError to the text-only hint', async () => {
    exportBookBundleMock.mockRejectedValue(new NoAudioToExportError())
    render(<BundleExportAction bookId={BOOK_ID} title="Dune" onClose={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /full/i }))
    })

    expect(await screen.findByText(/no audio to export/i)).toBeInTheDocument()
    expect(screen.getByText(/choose text-only/i)).toBeInTheDocument()
  })

  it('maps other BundleError subclasses to their message and offers Back to choices', async () => {
    exportBookBundleMock.mockRejectedValue(new CorruptBundleError('boom'))
    render(<BundleExportAction bookId={BOOK_ID} title="Dune" onClose={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /text-only/i }))
    })

    expect(await screen.findByText(/boom/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /back to choices/i }))
    expect(await screen.findByRole('button', { name: /text-only/i })).toBeInTheDocument()
  })
})

describe('BundleExportAction — close', () => {
  it('fires onClose when the dialog is dismissed', async () => {
    exportBookBundleMock.mockResolvedValue(makeBundle())
    const onClose = vi.fn()
    render(<BundleExportAction bookId={BOOK_ID} title="Dune" onClose={onClose} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /text-only/i }))
    })
    await screen.findByText(/Downloaded/)
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
