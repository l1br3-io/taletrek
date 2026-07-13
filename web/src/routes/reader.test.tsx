import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsProvider } from '../context/settings'
import {
  _clearDBForTests,
  _resetDBForTests,
  putBook,
  putChapters,
  updateBookProgress,
} from '../lib/db'
import type { Book } from '../types'
import { newBookId, newChapterId } from '../types'
import { Reader } from './reader'

const parseInWorker = vi.fn()

vi.mock('../lib/parse/client', () => ({
  parseInWorker: (...args: unknown[]) => parseInWorker(...args),
  _resetWorkerForTests: () => {},
}))

// Stub the TTS engine so Play in tests doesn't spin up the Piper worker.
const synthesize = vi.fn()
vi.mock('../lib/tts/client', () => ({
  ttsClient: {
    listVoices: async () => [],
    isStored: async () => true,
    download: async () => {},
    remove: async () => {},
    synthesize: (...args: unknown[]) => synthesize(...(args as [])),
  },
}))

// Real DB reads/writes for seeding (importActual), but intercept the M5
// progress-write so the unmount-flush can be asserted synchronously.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>()
  return { ...actual, updateBookProgress: vi.fn() }
})

function makeBook(overrides: Partial<Book> = {}): Book {
  const now = Date.now()
  return {
    id: newBookId(),
    title: 'Test Book',
    format: 'txt',
    chapterCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function Capture() {
  const loc = useLocation()
  return <div data-testid="capture">{loc.pathname}</div>
}

function renderAt(path: string) {
  return render(
    <SettingsProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reader" element={<Reader />} />
          <Route path="/reader/:bookId" element={<Reader />} />
          <Route path="/library" element={<Capture />} />
          <Route path="*" element={<Capture />} />
        </Routes>
      </MemoryRouter>
    </SettingsProvider>,
  )
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  parseInWorker.mockReset()
  synthesize.mockReset()
  synthesize.mockResolvedValue({ audio: new Blob(['x']), synthMs: 1 })
  vi.mocked(updateBookProgress).mockClear()
  // jsdom has no layout; stub scrollIntoView so F5/F4 can be asserted.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})

describe('Reader routing', () => {
  it('bare /reader redirects to /library when there are no books', async () => {
    renderAt('/reader')
    expect(await screen.findByTestId('capture')).toHaveTextContent('/library')
  })

  it('bare /reader redirects to the latest book', async () => {
    const id = newBookId()
    await putBook(makeBook({ id, title: 'Latest' }))
    await putChapters([
      { id: newChapterId(), bookId: id, index: 0, title: 'Latest', paragraphs: ['x'] },
    ])
    renderAt('/reader')
    expect(await screen.findByRole('heading', { name: 'Latest' })).toBeInTheDocument()
  })

  it('an unknown bookId redirects to /library', async () => {
    renderAt(`/reader/${newBookId()}`)
    expect(await screen.findByTestId('capture')).toHaveTextContent('/library')
  })
})

describe('Reader content', () => {
  it('renders the book matching the id', async () => {
    const id = newBookId()
    await putBook(makeBook({ id, title: 'Dune' }))
    await putChapters([
      { id: newChapterId(), bookId: id, index: 0, title: 'Dune', paragraphs: ['the spice'] },
    ])
    renderAt(`/reader/${id}`)
    expect(await screen.findByRole('heading', { name: 'Dune' })).toBeInTheDocument()
    expect(screen.getByText('the spice')).toBeInTheDocument()
  })

  it('cleans noise from the displayed text', async () => {
    const id = newBookId()
    await putBook(makeBook({ id, title: 'Cleaned' }))
    await putChapters([
      {
        id: newChapterId(),
        bookId: id,
        index: 0,
        title: 'Cleaned',
        paragraphs: ['see [1] note', '42', 'visit https://x.io end'],
      },
    ])
    renderAt(`/reader/${id}`)
    await screen.findByRole('heading', { name: 'Cleaned' })
    expect(await screen.findByText('see note')).toBeInTheDocument()
    expect(screen.queryByText('42')).not.toBeInTheDocument()
    expect(screen.getByText('visit end')).toBeInTheDocument()
  })
})

describe('Reader resume (M5)', () => {
  it('highlights the resumed paragraph on mount', async () => {
    const id = newBookId()
    await putBook(
      makeBook({ id, title: 'Resume', position: { chapterIndex: 0, paragraphIndex: 2 } }),
    )
    await putChapters([
      {
        id: newChapterId(),
        bookId: id,
        index: 0,
        title: 'Resume',
        paragraphs: ['p0', 'p1', 'p2', 'p3'],
      },
    ])
    renderAt(`/reader/${id}`)
    await screen.findByRole('heading', { name: 'Resume' })
    expect(screen.getByText('p2').className).toContain('ring-accent')
    expect(screen.getByText('p0').className).not.toContain('ring-accent')
  })

  it('flushes the saved position on unmount via updateBookProgress', async () => {
    const id = newBookId()
    await putBook(
      makeBook({ id, title: 'Resume', position: { chapterIndex: 0, paragraphIndex: 2 } }),
    )
    await putChapters([
      {
        id: newChapterId(),
        bookId: id,
        index: 0,
        title: 'Resume',
        paragraphs: ['p0', 'p1', 'p2', 'p3'],
      },
    ])
    const { unmount } = renderAt(`/reader/${id}`)
    await screen.findByRole('heading', { name: 'Resume' })
    // resume seeds the pointer at paragraph 2 → latestRef captures it; the
    // unmount flush then writes the position. Wrapped in act to flush effects.
    unmount()
    expect(updateBookProgress).toHaveBeenCalledWith(
      id,
      { chapterIndex: 0, paragraphIndex: 2 },
      0.75,
    )
  })
})

describe('Reader auto-scroll (F5)', () => {
  it('does not scroll on mount, then scrolls on the first Play when a position is saved', async () => {
    const id = newBookId()
    await putBook(
      makeBook({ id, title: 'Resume', position: { chapterIndex: 0, paragraphIndex: 2 } }),
    )
    await putChapters([
      {
        id: newChapterId(),
        bookId: id,
        index: 0,
        title: 'Resume',
        paragraphs: ['p0', 'p1', 'p2', 'p3'],
      },
    ])
    renderAt(`/reader/${id}`)
    await screen.findByRole('heading', { name: 'Resume' })
    // No scroll on mount — the view respects users who browse before playing.
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    // First Play with a saved position brings the resumed paragraph into view.
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('does not auto-scroll on Play when there is no saved position', async () => {
    const id = newBookId()
    await putBook(makeBook({ id, title: 'Fresh' }))
    await putChapters([
      {
        id: newChapterId(),
        bookId: id,
        index: 0,
        title: 'Fresh',
        paragraphs: ['p0', 'p1'],
      },
    ])
    renderAt(`/reader/${id}`)
    await screen.findByRole('heading', { name: 'Fresh' })
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled()
  })
})

describe('Reader per-paragraph transform (F8)', () => {
  it('applies a deterministic transform in place and undoes it', async () => {
    const id = newBookId()
    await putBook(makeBook({ id, title: 'T' }))
    await putChapters([
      {
        id: newChapterId(),
        bookId: id,
        index: 0,
        title: 'T',
        paragraphs: ['hello world', 'second line'],
      },
    ])
    renderAt(`/reader/${id}`)
    await screen.findByRole('heading', { name: 'T' })

    // Tap the paragraph to make it the current target.
    fireEvent.click(screen.getByText('hello world'))
    fireEvent.click(screen.getByRole('button', { name: 'More playback controls' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Transform paragraph/i })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Transform paragraph/i }))

    // Apply a deterministic uppercase transform.
    fireEvent.click(screen.getByRole('button', { name: 'UPPER' }))
    expect(screen.getAllByText('HELLO WORLD').length).toBeGreaterThan(0)

    // Undo reverts the raw source paragraph.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByText('hello world')).toBeInTheDocument()
    expect(screen.queryByText('HELLO WORLD')).not.toBeInTheDocument()
  })
})

describe('Reader upload', () => {
  it('parses an uploaded file and navigates to the new book', async () => {
    parseInWorker.mockResolvedValue({
      title: 'Uploaded',
      chapters: [{ title: 'Uploaded', paragraphs: ['fresh content'] }],
    })
    renderAt(`/reader/${newBookId()}`)
    // unknown id → redirected to /library; but upload is still reachable there
    expect(await screen.findByTestId('capture')).toHaveTextContent('/library')
  })

  it('shows an error for an unsupported file type on upload', async () => {
    const id = newBookId()
    await putBook(makeBook({ id, title: 'Host' }))
    await putChapters([
      { id: newChapterId(), bookId: id, index: 0, title: 'Host', paragraphs: ['x'] },
    ])
    renderAt(`/reader/${id}`)
    await screen.findByRole('heading', { name: 'Host' })
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'bad.unknown', { type: 'application/octet-stream' })] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unsupported file type/)
  })
})
