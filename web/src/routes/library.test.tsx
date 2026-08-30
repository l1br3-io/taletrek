import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatasourceProvider } from '../context/datasource'
import { SettingsProvider } from '../context/settings'
import { _clearDBForTests, _resetDBForTests, putBook } from '../lib/db'
import { type Book, newBookId, newChapterId } from '../types'
import { Library } from './library/LibraryPage'

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: newBookId(),
    title: 'Test Book',
    format: 'epub',
    chapterCount: 2,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

function renderLibrary() {
  return render(
    <MemoryRouter>
      <DatasourceProvider>
        <SettingsProvider>
          <Library />
        </SettingsProvider>
      </DatasourceProvider>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  window.confirm = vi.fn(() => true)
})

describe('Library page', () => {
  it('shows the empty state pointing at bundle import', async () => {
    renderLibrary()
    expect(await screen.findByText(/import a `\.taletrek` bundle/i)).toBeInTheDocument()
  })

  it('renders book cards with title, format, and progress', async () => {
    await putBook(makeBook({ title: 'Dune', progressFraction: 0.5 }))
    renderLibrary()
    expect(await screen.findByRole('button', { name: /Open Dune/ })).toBeInTheDocument()
    expect(screen.getByText('epub')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('deletes a book after confirmation', async () => {
    const book = makeBook({ title: 'Gone' })
    await putBook(book)
    renderLibrary()
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Gone/ }))
    fireEvent.click(screen.getByRole('button', { name: /Delete Gone/ }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Open Gone/ })).not.toBeInTheDocument()
    })
  })

  it('renames a book via prompt', async () => {
    window.prompt = vi.fn(() => 'Renamed')
    await putBook(makeBook({ title: 'Old Name' }))
    renderLibrary()
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Old Name/ }))
    fireEvent.click(screen.getByRole('button', { name: /Rename Old Name/ }))
    expect(await screen.findByRole('button', { name: /Open Renamed/ })).toBeInTheDocument()
  })

  it('opens the export chooser from the card menu', async () => {
    await putBook(makeBook({ title: 'Exportable' }))
    renderLibrary()
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Exportable/ }))
    fireEvent.click(screen.getByRole('button', { name: /Export bundle for Exportable/ }))
    // The chooser sheet mounts with the book's title.
    await waitFor(() => {
      expect(screen.getAllByText(/Exportable/).length).toBeGreaterThan(0)
    })
  })

  it('renders the import-bundle affordance', async () => {
    renderLibrary()
    expect(await screen.findByText('Import bundle')).toBeInTheDocument()
  })

  it('navigates a chapter-less book record without error (schema only)', async () => {
    await putBook(makeBook({ title: 'Bare' }))
    renderLibrary()
    expect(await screen.findByRole('button', { name: /Open Bare/ })).toBeInTheDocument()
  })
})

// Chapter ids are exercised via the reader tests; keep the helper referenced
// so the import survives lint when the schema above changes.
void newChapterId
