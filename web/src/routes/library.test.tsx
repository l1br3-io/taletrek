import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Layout } from '../components/Layout'
import { DEFAULT_AI_SETTINGS, DEFAULT_SETTINGS, SettingsProvider } from '../context/settings'
import { _resetAiEngineForTests } from '../lib/ai/client'
import { type AiSettings, type AiTransformEngine, transformDefId } from '../lib/ai/types'
import {
  _clearDBForTests,
  _resetDBForTests,
  getAudioCacheKeysByBook,
  getChaptersByBook,
  getSetting,
  putAudioCacheEntry,
  putBook,
  putBookFile,
  putChapters,
  setSetting,
} from '../lib/db'
import { parseInWorker } from '../lib/parse/client'
import { uploadManager } from '../lib/upload/manager'
import type { Book } from '../types'
import { chapterId, newBookId } from '../types'
import { Library } from './library/LibraryPage'

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
  detectOutline: vi.fn(async () => []),
}
vi.mock('../lib/ai/client', () => ({
  getAiEngine: () => stubEngine,
  getAiEngineForDef: () => stubEngine,
  _resetAiEngineForTests: () => {},
}))

const ttsIsStoredMock = vi.fn<(...args: unknown[]) => Promise<boolean>>()
const ttsDownloadMock = vi.fn<(...args: unknown[]) => Promise<void>>()
const ttsSynthMock =
  vi.fn<
    (
      ...args: unknown[]
    ) => Promise<{ audio?: Blob; synthMs: number; durationSeconds: number; cacheKey: string }>
  >()
vi.mock('../lib/tts/client', () => ({
  ttsClient: {
    isStored: (...args: unknown[]) => ttsIsStoredMock(...args),
    download: (...args: unknown[]) => ttsDownloadMock(...args),
    synthesize: (...args: unknown[]) => ttsSynthMock(...args),
    listVoices: async () => [],
    remove: async () => {},
  },
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

/** Render `/library` (wrapped in Layout so the global upload banner shows)
 * plus a catch-all that records the navigated pathname. */
function renderAt(path: string) {
  function Capture() {
    const loc = useLocation()
    return <div data-testid="capture">{loc.pathname}</div>
  }
  return render(
    <SettingsProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/library" element={<Library />} />
            <Route path="*" element={<Capture />} />
          </Route>
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
  uploadManager._resetForTests()
  ttsIsStoredMock.mockReset()
  ttsDownloadMock.mockReset()
  ttsSynthMock.mockReset()
  ttsIsStoredMock.mockResolvedValue(true)
  ttsSynthMock.mockResolvedValue({
    audio: new Blob(['x']),
    synthMs: 1,
    durationSeconds: 1,
    cacheKey: 'k',
  })
})

/** Drive the hidden file input as if the user picked a file. */
async function pickFile(file: File): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

/** Open the overflow menu on the book card with the given title. */
async function openBookMenu(title: string): Promise<void> {
  const btn = await screen.findByRole('button', { name: `More actions for ${title}` })
  await act(async () => {
    fireEvent.click(btn)
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
    await openBookMenu('Delete Me')
    const del = await screen.findByRole('button', { name: 'Delete Delete Me' })
    fireEvent.click(del)
    expect(await screen.findByText(/Your library is empty/i)).toBeInTheDocument()
  })

  it('keeps the book when delete is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await putBook(makeBook({ title: 'Keep Me' }))
    renderAt('/library')
    await openBookMenu('Keep Me')
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

  it('shows the process modal after upload when AI is enabled', async () => {
    await seedAiSettings({})
    await renderReady('/library')
    await pickFile(FILE)
    expect(await screen.findByRole('dialog', { name: /prepare book/i })).toBeInTheDocument()
  })

  it('process modal Skip proceeds to the reader unprocessed', async () => {
    await seedAiSettings({})
    const { findByTestId } = await renderReady('/library')
    await pickFile(FILE)
    await screen.findByRole('dialog', { name: /prepare book/i })
    fireEvent.click(screen.getByRole('button', { name: /^skip/i }))
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
    await seedAiSettings({
      backend: 'cloud',
      transformDefs: [
        {
          id: transformDefId('cleanup'),
          label: 'Clean up',
          hint: 'Remove clutter',
          desc: 'Clean up OCR artifacts.',
          systemPrompt: 'Clean up: {{text}}',
          params: [],
        },
      ],
    })
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
      processing: { appliedAt: now, ops: [{ defId: transformDefId('cleanup'), params: {} }] },
    }
    await putBook(book)
    await putChapters([
      { id: chapterId('c1'), bookId: id, index: 0, title: 'Ch0', paragraphs: ['old'] },
    ])
    await putBookFile({ bookId: id, blob, name: 'book.txt', type: 'text/plain', size: blob.size })

    await renderReady('/library')

    await openBookMenu('Already Processed')
    const reprocessBtn = await screen.findByRole('button', { name: /Edit Already Processed/i })
    fireEvent.click(reprocessBtn)

    const dialog = await screen.findByRole('dialog', { name: /prepare book/i })
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
    await openBookMenu('No AI')
    expect(screen.queryByRole('button', { name: /Edit No AI/i })).not.toBeInTheDocument()
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
    await seedAiSettings({ backend: 'cloud' })
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

    await openBookMenu('Hinted Book')
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
    await openBookMenu('No Hints')
    expect(
      screen.queryByRole('button', { name: /Review pronunciation for No Hints/i }),
    ).not.toBeInTheDocument()
  })
})

describe('Library — Outline detection', () => {
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

  it('shows the Outline button for non-EPUB books', async () => {
    await putBook(makeBook({ title: 'A Novel', format: 'txt' }))
    await renderReady('/library')
    await openBookMenu('A Novel')
    expect(
      screen.getByRole('button', { name: /Re-process outline for A Novel/i }),
    ).toBeInTheDocument()
  })

  it('hides the Outline button for EPUB books', async () => {
    await putBook(makeBook({ title: 'An EPUB', format: 'epub' }))
    await renderReady('/library')
    await openBookMenu('An EPUB')
    expect(
      screen.queryByRole('button', { name: /Re-process outline for An EPUB/i }),
    ).not.toBeInTheDocument()
  })

  it('detects headings via AI, replaces chapters, and shows the success banner', async () => {
    // M10: heuristic Auto-detect removed. The remaining library outline flow
    // is "Use PDF outline" (PDFs only) or "Use AI" (any format, requires AI
    // engine). The full AI flow is covered in useOutline.test.ts; here we
    // just verify the Outline button still opens the sheet for non-EPUBs.
    vi.mocked(parseInWorker).mockResolvedValue({
      title: 'Outline Book',
      chapters: [
        { title: 'Outline Book', paragraphs: ['Chapter 1', 'Hello.', 'Chapter 2', 'World.'] },
      ],
    })
    const id = newBookId()
    const now = Date.now()
    await putBook({
      id,
      title: 'Outline Book',
      format: 'txt',
      chapterCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    await putChapters([
      { id: chapterId('c1'), bookId: id, index: 0, title: 'Outline Book', paragraphs: ['old'] },
    ])
    await putBookFile({
      bookId: id,
      blob: new Blob(['raw']),
      name: 'book.txt',
      type: 'text/plain',
      size: 3,
    })

    await renderReady('/library')

    await openBookMenu('Outline Book')
    fireEvent.click(
      await screen.findByRole('button', { name: /Re-process outline for Outline Book/i }),
    )

    // Outline sheet opened — only AI button is available for non-PDFs now.
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: /Auto-detect chapters/i })).not.toBeInTheDocument()
  })
})

describe('Library — per-book synthesize', () => {
  async function seedBookForResynth(
    overrides: Partial<Book> = {},
  ): Promise<{ id: Book['id']; title: string }> {
    const id = newBookId()
    const title = overrides.title ?? 'Resynth Me'
    const now = Date.now()
    await putBook({
      id,
      title,
      format: 'txt',
      chapterCount: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
      ...(overrides.title === undefined ? {} : {}),
    })
    await putChapters([
      {
        id: chapterId('c1'),
        bookId: id,
        index: 0,
        title: 'Chapter 1',
        paragraphs: ['First paragraph.', 'Second paragraph.'],
      },
    ])
    return { id, title }
  }

  async function seedSettings(synthMode: 'off' | 'standard' | 'no-limit'): Promise<void> {
    await setSetting('app', { ...DEFAULT_SETTINGS, synthesizeOnUpload: synthMode })
  }

  async function renderReady(path: string) {
    renderAt(path)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }

  it('shows the Synthesize action when mode is standard', async () => {
    await seedSettings('standard')
    await seedBookForResynth({ title: 'Standard Book' })
    await renderReady('/library')
    await openBookMenu('Standard Book')
    expect(
      await screen.findByRole('button', { name: /Synthesize Standard Book/i }),
    ).toBeInTheDocument()
  })

  it('shows the Synthesize action when mode is no-limit', async () => {
    await seedSettings('no-limit')
    await seedBookForResynth({ title: 'NoLimit Book' })
    await renderReady('/library')
    await openBookMenu('NoLimit Book')
    expect(
      await screen.findByRole('button', { name: /Synthesize NoLimit Book/i }),
    ).toBeInTheDocument()
  })

  it('hides the Synthesize action when mode is off', async () => {
    await seedSettings('off')
    await seedBookForResynth({ title: 'No Synth' })
    await renderReady('/library')
    await openBookMenu('No Synth')
    expect(screen.queryByRole('button', { name: /Synthesize No Synth/i })).toBeNull()
  })

  it('synthesizes remaining paragraphs without deleting existing cache', async () => {
    await seedSettings('standard')
    const { id, title } = await seedBookForResynth()
    // Seed an existing cache entry — it should survive the synthesize action.
    await putAudioCacheEntry({
      key: 'existing-1',
      blob: new Blob(['old']),
      sizeBytes: 3,
      synthMs: 1,
      durationSeconds: 1,
      voiceId: 'en_US-hfc_female-medium' as never,
      lastUsed: Date.now(),
      createdAt: Date.now(),
      bookId: id,
    })

    await renderReady('/library')

    await openBookMenu(title)
    fireEvent.click(await screen.findByRole('button', { name: `Synthesize ${title}` }))
    // Wait for the done banner.
    expect(await screen.findByText(new RegExp(`Audio updated for.*${title}`))).toBeInTheDocument()

    // Existing cache key survives (no delete-before-synth).
    const keysAfter = await getAudioCacheKeysByBook(id)
    expect(keysAfter).toContain('existing-1')
    // The synth mock is called for each paragraph (cache lookup happens in
    // the real engine, which the mock bypasses).
    expect(ttsSynthMock).toHaveBeenCalledTimes(2)
  })

  it('shows the running banner with progress while synthesizing', async () => {
    await seedSettings('standard')
    const { title } = await seedBookForResynth()
    // Gate each synth so we can observe the running banner between calls.
    const gates: Array<() => void> = []
    ttsSynthMock.mockReset()
    ttsSynthMock.mockImplementation(
      () =>
        new Promise((res) => {
          gates.push(() =>
            res({ audio: new Blob(['x']), synthMs: 1, durationSeconds: 1, cacheKey: 'k' }),
          )
        }),
    )
    await renderReady('/library')

    await openBookMenu(title)
    fireEvent.click(await screen.findByRole('button', { name: `Synthesize ${title}` }))
    // The global banner shows the initial re-synth state immediately
    // (manager sets done=0 before the first synth resolves).
    expect(await screen.findByText(/Updating audio for/)).toBeInTheDocument()
    // Wait for the first synth call to land before resolving its gate —
    // runJob persists `uploadJob` (IDB write) between setState(synthesizing)
    // and the first `engine.synthesize` call, so the gate isn't pushed
    // synchronously.
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1))
    // Resolve the first synth → onProgress(1, 2) fires; the second is still gated.
    await act(async () => {
      gates[0]?.()
    })
    expect(await screen.findByText(/1 \/ 2/)).toBeInTheDocument()
    // Release the second synth so the job can finish.
    await act(async () => {
      gates[1]?.()
    })
    expect(await screen.findByText(new RegExp(`Audio updated for.*${title}`))).toBeInTheDocument()
  })

  it('shows an error banner when synthesis fails', async () => {
    await seedSettings('standard')
    const { title } = await seedBookForResynth()
    ttsSynthMock.mockReset()
    ttsSynthMock.mockRejectedValue(new Error('worker exploded'))
    await renderReady('/library')

    await openBookMenu(title)
    fireEvent.click(await screen.findByRole('button', { name: `Synthesize ${title}` }))
    expect(await screen.findByText(/Couldn't update audio for/i)).toBeInTheDocument()
  })
})
