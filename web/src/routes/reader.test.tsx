import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsProvider } from '../context/settings'
import { _clearDBForTests, _resetDBForTests } from '../lib/db'
import { Reader } from './reader'

const parseInWorker = vi.fn()

vi.mock('../lib/parse/client', () => ({
  parseInWorker: (...args: unknown[]) => parseInWorker(...args),
  _resetWorkerForTests: () => {},
}))

function withProviders(node: React.ReactElement) {
  return (
    <MemoryRouter>
      <SettingsProvider>{node}</SettingsProvider>
    </MemoryRouter>
  )
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  parseInWorker.mockReset()
})

describe('Reader', () => {
  it('shows the empty state when no book exists', async () => {
    render(withProviders(<Reader />))
    expect(await screen.findByText(/No book loaded yet/i)).toBeInTheDocument()
  })

  it('parses and displays an uploaded book', async () => {
    parseInWorker.mockResolvedValue({
      title: 'My Book',
      chapters: [{ title: 'My Book', paragraphs: ['Hello world.', 'Second paragraph.'] }],
    })
    render(withProviders(<Reader />))
    await screen.findByText(/No book loaded yet/i)
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'my.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByRole('heading', { name: 'My Book' })).toBeInTheDocument()
    expect(screen.getByText('Hello world.')).toBeInTheDocument()
    expect(screen.getByText('Second paragraph.')).toBeInTheDocument()
  })

  it('shows the parsing banner while a book is being parsed', async () => {
    let resolveParse: (value: unknown) => void = () => {}
    parseInWorker.mockReturnValue(
      new Promise((resolve) => {
        resolveParse = resolve
      }),
    )
    render(withProviders(<Reader />))
    await screen.findByText(/No book loaded yet/i)
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'slow.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Parsing “slow.txt”')
    resolveParse({
      title: 'slow',
      chapters: [{ title: 'slow', paragraphs: ['done'] }],
    })
    expect(await screen.findByText('done')).toBeInTheDocument()
  })

  it('shows an error for an unsupported file type', async () => {
    render(withProviders(<Reader />))
    await screen.findByText(/No book loaded yet/i)
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'bad.unknown', { type: 'application/octet-stream' })] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unsupported file type/)
  })

  it('shows an error when parsing fails', async () => {
    parseInWorker.mockRejectedValue(new Error('boom'))
    render(withProviders(<Reader />))
    await screen.findByText(/No book loaded yet/i)
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'ok.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
  })
})
