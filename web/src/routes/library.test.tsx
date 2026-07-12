import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_SETTINGS, DEFAULT_SETTINGS, SettingsProvider } from '../context/settings'
import { _resetAiEngineForTests } from '../lib/ai/client'
import type { AiSettings, AiTransformEngine } from '../lib/ai/types'
import {
  _clearDBForTests,
  _resetDBForTests,
  getChaptersByBook,
  getSetting,
  putBook,
  putBookFile,
  putChapters,
  setSetting,
} from '../lib/db'
import { parseInWorker } from '../lib/parse/client'
import type { Book } from '../types'
import { chapterId, newBookId } from '../types'
import { Library } from './library'

vi.mock('../lib/parse/client', () => ({
  parseInWorker: vi.fn(),
  _resetWorkerForTests: () => {},
}))

const ingestMock = vi.fn()
vi.mock('../lib/ingest', () => ({
  ingestBook: (file: File) => ingestMock(file),
  UnsupportedFileError: class UnsupportedFileError extends Error {
    override readonly name = 'UnsupportedFileError'
  },
}))

const stubEngine: AiTransformEngine = {
  isReady: () => Promise.resolve(true),
  transform: vi.fn(async (input: string[]) => input.map((p) => `[done] ${p}`)),
  proposePronunciationHints: vi.fn(async () => []),
}
vi.mock('../lib/ai/client', () => ({
  getAiEngine: () => stubEngine,
  createAiEngine: () => stubEngine,
  _resetAiEngineForTests: () => {},
}))

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

/** Render `/library` plus a catch-all that records the navigated pathname. */
function renderAt(path: string) {
  function Capture() {
    const loc = useLocation()
    return <div data-testid="capture">{loc.pathname}</div>
  }
  return render(
    <SettingsProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/library" element={<Library />} />
          <Route path="*" element={<Capture />} />
        </Routes>
      </MemoryRouter>
    </SettingsProvider>,
  )
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
  ingestMock.mockReset()
  _resetAiEngineForTests()
})

/** Drive the hidden file input as if the user picked a file. */
async function pickFile(file: File): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

describe('Library', () => {
  it('shows the empty state when there are no books', async () => {
    renderAt('/library')
    expect(await screen.findByText(/Your library is empty/i)).toBeInTheDocument()
  })

  it('lists seeded books with titles and formats', async () => {
    await putBook(makeBook({ title: 'Dune', format: 'epub' }))
    await putBook(makeBook({ title: 'Moby Dick', format: 'txt' }))
    renderAt('/library')
    expect(await screen.findByText('Dune')).toBeInTheDocument()
    expect(screen.getByText('Moby Dick')).toBeInTheDocument()
  })

  it('navigates to /reader/:id when a card is opened', async () => {
    const id = newBookId()
    await putBook(makeBook({ id, title: 'Open Me' }))
    const { findByTestId } = renderAt('/library')
    const card = await screen.findByRole('button', { name: 'Open Open Me' })
    fireEvent.click(card)
    const capture = await findByTestId('capture')
    expect(capture.textContent).toBe(`/reader/${id}`)
  })

  it('deletes a book after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await putBook(makeBook({ title: 'Delete Me' }))
    renderAt('/library')
    const del = await screen.findByRole('button', { name: 'Delete Delete Me' })
    fireEvent.click(del)
    expect(await screen.findByText(/Your library is empty/i)).toBeInTheDocument()
  })

  it('keeps the book when delete is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await putBook(makeBook({ title: 'Keep Me' }))
    renderAt('/library')
    const del = await screen.findByRole('button', { name: 'Delete Keep Me' })
    fireEvent.click(del)
    expect(await screen.findByText('Keep Me')).toBeInTheDocument()
  })

  it('renders a progress bar from progressFraction', async () => {
    await putBook(makeBook({ title: 'Halfway', progressFraction: 0.5 }))
    renderAt('/library')
    const bar = await screen.findByRole('progressbar', { name: '50% read' })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
  })
})

async function seedAiSettings(overrides: Partial<AiSettings>): Promise<void> {
  await setSetting('app', {
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_AI_SETTINGS, enabled: true, ...overrides },
  })
}

describe('Library — AI upload flow (M6)', () => {
  const FILE = new File(['hello world'], 'book.txt', { type: 'text/plain' })

  /** Render + let SettingsProvider hydrate from the seeded `app` value so ai.enabled is live. */
  async function renderReady(path: string) {
    const utils = renderAt(path)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    return utils
  }

  beforeEach(() => {
    ingestMock.mockResolvedValue({
      book: {
        id: newBookId(),
        title: 'Book',
        format: 'txt',
        chapterCount: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      chapters: [{ id: 'c1', bookId: 'b1', index: 0, title: 'C0', paragraphs: ['hello world'] }],
    })
  })

  it('with AI disabled (default), upload goes straight to the reader — no modal', async () => {
    const { findByTestId } = await renderReady('/library')
    await pickFile(FILE)
    const capture = await findByTestId('capture')
    expect(capture.textContent).toMatch(/\/reader\//)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the post-upload modal when afterUpload is on', async () => {
    await seedAiSettings({ modal: { beforeUpload: false, afterUpload: true } })
    await renderReady('/library')
    await pickFile(FILE)
    expect(await screen.findByRole('dialog', { name: /process book/i })).toBeInTheDocument()
  })

  it('opens the pre-upload modal on the upload click when beforeUpload is on (no ingest yet)', async () => {
    await seedAiSettings({ modal: { beforeUpload: true, afterUpload: false } })
    await renderReady('/library')
    fireEvent.click(screen.getByRole('button', { name: /upload a book/i }))
    expect(await screen.findByRole('dialog', { name: /process book/i })).toBeInTheDocument()
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('post-upload modal cancel proceeds to the reader unprocessed', async () => {
    await seedAiSettings({ modal: { beforeUpload: false, afterUpload: true } })
    const { findByTestId } = await renderReady('/library')
    await pickFile(FILE)
    await screen.findByRole('dialog', { name: /process book/i })
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    const capture = await findByTestId('capture')
    expect(capture.textContent).toMatch(/\/reader\//)
  })
})

describe('Library — Reprocess (M6 T7)', () => {
  /** Render + let SettingsProvider hydrate from the seeded `app` value. */
  async function renderReady(path: string) {
    const utils = renderAt(path)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    return utils
  }

  beforeEach(() => {
    ingestMock.mockReset()
    vi.mocked(parseInWorker).mockReset()
  })

  it('reprocesses a book: re-parses original, transforms, writes chapters, stays in library', async () => {
    await seedAiSettings({ backend: 'cloud', modal: { beforeUpload: false, afterUpload: false } })
    vi.mocked(parseInWorker).mockResolvedValue({
      title: 'Reprocessed',
      chapters: [{ title: 'Ch0', paragraphs: ['fresh-a', 'fresh-b'] }],
    })
    const id = newBookId()
    const now = Date.now()
    const blob = new File(['hello world'], 'book.txt', { type: 'text/plain' })
    const book: Book = {
      id,
      title: 'Already Processed',
      format: 'txt',
      chapterCount: 1,
      createdAt: now,
      updatedAt: now,
      processing: { appliedAt: now, transforms: ['cleanup'], params: {} },
    }
    await putBook(book)
    await putChapters([
      { id: chapterId('c1'), bookId: id, index: 0, title: 'Ch0', paragraphs: ['old'] },
    ])
    await putBookFile({ bookId: id, blob, name: 'book.txt', type: 'text/plain', size: blob.size })

    await renderReady('/library')

    const reprocessBtn = await screen.findByRole('button', { name: /Reprocess Already Processed/i })
    fireEvent.click(reprocessBtn)

    const dialog = await screen.findByRole('dialog', { name: /process book/i })
    // initialOps pre-fills from Book.processing — the modal's useEffect seeds it
    // one tick after open, so wait for the checkbox to settle.
    await waitFor(() => {
      expect(within(dialog).getByRole('checkbox', { name: /clean up/i })).toBeChecked()
    })

    fireEvent.click(within(dialog).getByRole('button', { name: /process book/i }))
    await screen.findByText(/Transform applied/i)

    const stored = await getChaptersByBook(id)
    expect(stored[0]?.paragraphs).toEqual(['[done] fresh-a', '[done] fresh-b'])

    expect(screen.queryByTestId('capture')).not.toBeInTheDocument()
  })

  it('hides the Reprocess action when AI is disabled', async () => {
    await putBook(makeBook({ title: 'No AI' }))
    await renderReady('/library')
    await screen.findByText('No AI')
    expect(screen.queryByRole('button', { name: /Reprocess No AI/i })).not.toBeInTheDocument()
  })
})

describe('Library — Pronunciation hints (M6 T8)', () => {
  async function renderReady(path: string) {
    const utils = renderAt(path)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    return utils
  }

  beforeEach(() => {
    ingestMock.mockReset()
    vi.mocked(parseInWorker).mockReset()
  })

  it('scans hints, accepts a candidate, and merges into the pronunciation dictionary', async () => {
    await seedAiSettings({ backend: 'cloud', modal: { beforeUpload: false, afterUpload: false } })
    stubEngine.proposePronunciationHints = vi.fn(async () => [
      {
        id: 'h1',
        find: 'Siobhan',
        replace: 'Shi-vawn',
        confidence: 0.9,
        category: 'proper-noun' as const,
      },
    ])
    const id = newBookId()
    const now = Date.now()
    await putBook({
      id,
      title: 'Hinted Book',
      format: 'txt',
      chapterCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    await putChapters([
      { id: chapterId('c1'), bookId: id, index: 0, title: 'C0', paragraphs: ['Siobhan arrived.'] },
    ])

    await renderReady('/library')

    fireEvent.click(
      await screen.findByRole('button', { name: /Review pronunciation for Hinted Book/i }),
    )

    const dialog = await screen.findByRole('dialog', { name: /pronunciation review/i })
    await waitFor(() => {
      expect(within(dialog).getByRole('checkbox', { name: /accept siobhan/i })).toBeInTheDocument()
    })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /accept siobhan/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /save 1 accepted/i }))

    await waitFor(async () => {
      const stored = await getSetting<{ cleaning: { pronunciation: unknown[] } }>('app')
      expect(stored?.cleaning.pronunciation).toEqual([
        { id: 'h1', find: 'Siobhan', replace: 'Shi-vawn' },
      ])
    })
  })

  it('hides the Hints action when AI is disabled', async () => {
    await putBook(makeBook({ title: 'No Hints' }))
    await renderReady('/library')
    await screen.findByText('No Hints')
    expect(
      screen.queryByRole('button', { name: /Review pronunciation for No Hints/i }),
    ).not.toBeInTheDocument()
  })
})
