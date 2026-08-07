import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BundleTooLargeError,
  CorruptBundleError,
  UnsupportedBundleKindError,
  UnsupportedSchemaVersionError,
} from '../lib/bundle/errors'
import { BundleImportButton } from './BundleImportButton'

const readBookBundleMock = vi.fn()
const importBookBundleMock = vi.fn()

vi.mock('../lib/bundle/reader', () => ({
  readBookBundle: (...args: unknown[]) => readBookBundleMock(...args),
}))

vi.mock('../lib/bundle/import', () => ({
  importBookBundle: (...args: unknown[]) => importBookBundleMock(...args),
}))

/** Minimal bundle shape — only the fields the component reads (title + audio.present). */
function makeBundle(overrides: { title?: string; full?: boolean } = {}) {
  const title = overrides.title ?? 'Imported Book'
  return {
    manifest: {
      book: { title },
      audio: { present: overrides.full ?? true },
    },
  }
}

async function pickBundle(file: File): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

const BUNDLE = new File(['bytes'], 'book.taletrek')

describe('BundleImportButton', () => {
  beforeEach(() => {
    readBookBundleMock.mockReset()
    importBookBundleMock.mockReset()
    importBookBundleMock.mockResolvedValue({ bookId: 'b1', imported: { chapters: 1, audio: 0 } })
  })

  it('reads, imports, and calls onImported with the report (full bundle)', async () => {
    readBookBundleMock.mockResolvedValue(makeBundle({ title: 'Dune', full: true }))
    const onImported = vi.fn()
    render(<BundleImportButton onImported={onImported} />)

    await pickBundle(BUNDLE)

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1))
    expect(onImported).toHaveBeenCalledWith({ title: 'Dune', full: true })
    expect(readBookBundleMock).toHaveBeenCalledTimes(1)
    // The bytes are forwarded as a Uint8Array (the reader's input contract).
    const passed = readBookBundleMock.mock.calls[0]?.[0]
    expect(passed).toBeInstanceOf(Uint8Array)
    expect(importBookBundleMock).toHaveBeenCalledTimes(1)
  })

  it('reports full=false for a text-only bundle', async () => {
    readBookBundleMock.mockResolvedValue(makeBundle({ title: 'Novel', full: false }))
    const onImported = vi.fn()
    render(<BundleImportButton onImported={onImported} />)

    await pickBundle(BUNDLE)

    await waitFor(() => expect(onImported).toHaveBeenCalledWith({ title: 'Novel', full: false }))
  })

  it('shows a success toast naming the imported title', async () => {
    readBookBundleMock.mockResolvedValue(makeBundle({ title: 'Hyperion', full: true }))
    render(<BundleImportButton onImported={vi.fn()} />)

    await pickBundle(BUNDLE)

    expect(await screen.findByText(/Imported .Hyperion./)).toBeInTheDocument()
  })

  it.each([
    ['corrupt', new CorruptBundleError('bad zip'), "This file isn't a TaleTrek bundle"],
    [
      'library kind',
      new UnsupportedBundleKindError('library'),
      "Library bundles aren't supported yet",
    ],
    [
      'newer schema',
      new UnsupportedSchemaVersionError(2, [1]),
      /This bundle is from a newer TaleTrek/,
    ],
  ])('maps %s error to the right toast text', async (_label, error, expected) => {
    readBookBundleMock.mockRejectedValue(error)
    render(<BundleImportButton onImported={vi.fn()} />)

    await pickBundle(BUNDLE)

    expect(await screen.findByText(expected)).toBeInTheDocument()
  })

  it('maps the too-large error (thrown by the importer) to the storage toast', async () => {
    readBookBundleMock.mockResolvedValue(makeBundle())
    importBookBundleMock.mockRejectedValue(new BundleTooLargeError())
    render(<BundleImportButton onImported={vi.fn()} />)

    await pickBundle(BUNDLE)

    expect(await screen.findByText('Not enough storage to import this bundle.')).toBeInTheDocument()
  })

  it('does not call onImported when import fails', async () => {
    readBookBundleMock.mockRejectedValue(new CorruptBundleError('x'))
    const onImported = vi.fn()
    render(<BundleImportButton onImported={onImported} />)

    await pickBundle(BUNDLE)

    await screen.findByText("This file isn't a TaleTrek bundle")
    expect(onImported).not.toHaveBeenCalled()
  })

  it('resets the input so the same file can be re-selected', async () => {
    readBookBundleMock.mockResolvedValue(makeBundle())
    render(<BundleImportButton onImported={vi.fn()} />)

    await pickBundle(BUNDLE)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.value).toBe('')
  })

  it('disables the control while busy', async () => {
    readBookBundleMock.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(makeBundle()), 50)),
    )
    render(<BundleImportButton onImported={vi.fn()} />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [BUNDLE] } })
    })

    await waitFor(() => expect(input).toBeDisabled())
    await screen.findByText(/Imported /)
  })

  it('disables the control when the disabled prop is set', () => {
    render(<BundleImportButton onImported={vi.fn()} disabled />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeDisabled()
  })
})
