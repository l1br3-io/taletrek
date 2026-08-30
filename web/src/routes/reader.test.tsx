import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { DatasourceProvider } from '../context/datasource'
import { SettingsProvider } from '../context/settings'
import { _clearDBForTests, _resetDBForTests, putBook, putChapters } from '../lib/db'
import { bookId, newBookId, newChapterId } from '../types'
import { Reader } from './reader/ReaderPane'

function seedBook(title: string): string {
  const bid = newBookId()
  void putBook({
    id: bid,
    title,
    format: 'txt',
    chapterCount: 1,
    createdAt: 1,
    updatedAt: 2,
  })
  void putChapters([
    {
      id: newChapterId(),
      bookId: bid,
      index: 0,
      title: 'Chapter One',
      paragraphs: ['First paragraph.', 'Second paragraph.'],
    },
  ])
  return bid
}

function renderReader(bid: string) {
  return render(
    <MemoryRouter initialEntries={[`/reader/${bid}`]}>
      <DatasourceProvider>
        <SettingsProvider>
          <Routes>
            <Route path="/reader/:bookId" element={<Reader />} />
            <Route path="/library" element={<div>library-stub</div>} />
          </Routes>
        </SettingsProvider>
      </DatasourceProvider>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('Reader', () => {
  it('loads the book by id and renders title + paragraphs', async () => {
    const bid = seedBook('Reader Book')
    renderReader(bid)
    expect(await screen.findByText('Reader Book')).toBeInTheDocument()
    expect(screen.getByText('First paragraph.')).toBeInTheDocument()
    expect(screen.getByText('Second paragraph.')).toBeInTheDocument()
    // The playback bar renders alongside the text.
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('redirects to the library when the book does not exist', async () => {
    renderReader(bookId('does-not-exist'))
    expect(await screen.findByText('library-stub')).toBeInTheDocument()
  })
})
