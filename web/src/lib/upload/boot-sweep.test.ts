import { beforeEach, describe, expect, it } from 'vitest'
import type { Book } from '../../types'
import { newBookId, voiceId } from '../../types'
import { putBookAudio } from '../book-audio'
import { _clearDBForTests, _resetDBForTests, getAllBooks, getBook, putBook } from '../db'
import { reconcileInterruptedUploads } from './boot-sweep'

const VOICE = voiceId('en_US-hfc_female-medium')

function makeBook(opts: { uploading?: boolean; title?: string }): Book {
  const now = Date.now()
  return {
    id: newBookId(),
    title: opts.title ?? 'Test',
    format: 'txt',
    chapterCount: 1,
    createdAt: now,
    updatedAt: now,
    ...(opts.uploading ? { uploading: true } : {}),
  }
}

const CLEANING = {
  enabled: false,
  filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
  pronunciation: [],
}

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('reconcileInterruptedUploads', () => {
  it('converts stuck books with no audio to paused (keeps book + clears uploading)', async () => {
    const stuck = makeBook({ uploading: true, title: 'Interrupted' })
    await putBook(stuck)
    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 0, convertedToPaused: 1, transformedToPaused: 0 })

    const refreshed = await getBook(stuck.id)
    expect(refreshed).toBeDefined()
    expect(refreshed?.uploading).toBeUndefined()
  })

  it('preserves the persisted uploadJob when converting to paused', async () => {
    // runJob writes uploadJob at start now — the sweep must NOT disturb it.
    const stuck: Book = {
      ...makeBook({ uploading: true, title: 'Interrupted With Job' }),
      uploadJob: {
        voiceId: VOICE,
        cleaning: CLEANING,
        mode: 'initial',
        done: 7,
        total: 42,
        pausedAt: Date.now(),
        lastFlatIndex: 7,
        lastChapterTitle: 'Chapter 8',
        lastParagraphInChapter: 4,
        lastChapterTotal: 12,
      },
    }
    await putBook(stuck)

    await reconcileInterruptedUploads()

    const refreshed = await getBook(stuck.id)
    expect(refreshed?.uploading).toBeUndefined()
    expect(refreshed?.uploadJob).toBeDefined()
    expect(refreshed?.uploadJob?.done).toBe(7)
    expect(refreshed?.uploadJob?.lastChapterTitle).toBe('Chapter 8')
  })

  it('handles legacy stuck books without an uploadJob (clears flag only)', async () => {
    // Pre-2026-07 books may have uploading=true without a persisted uploadJob.
    // Sweep should still convert to a non-uploading state so the library
    // doesn't show a stale "Uploading…" badge — user can hit "Synthesize"
    // from the card menu.
    const legacy = makeBook({ uploading: true, title: 'Legacy' })
    await putBook(legacy)

    await reconcileInterruptedUploads()

    const refreshed = await getBook(legacy.id)
    expect(refreshed).toBeDefined()
    expect(refreshed?.uploading).toBeUndefined()
    expect(refreshed?.uploadJob).toBeUndefined()
  })

  it('clears the flag when audio exists (interrupted re-synth)', async () => {
    const stuck = makeBook({ uploading: true, title: 'Resynth Interrupted' })
    await putBook(stuck)
    await putBookAudio({
      bookId: stuck.id,
      blob: new Blob(['audio']),
      duration: 10,
      paragraphOffsets: [0],
      durations: [10],
      voiceId: VOICE,
      createdAt: Date.now(),
    })

    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 1, convertedToPaused: 0, transformedToPaused: 0 })

    const refreshed = await getBook(stuck.id)
    expect(refreshed).toBeDefined()
    expect(refreshed?.uploading).toBeUndefined()
  })

  it('leaves books without the uploading flag untouched', async () => {
    const complete = makeBook({ title: 'Done Book' })
    const stuck = makeBook({ uploading: true, title: 'Stuck' })
    await putBook(complete)
    await putBook(stuck)

    await reconcileInterruptedUploads()

    const all = await getAllBooks()
    expect(all.find((b) => b.id === complete.id)).toBeDefined()
    expect(all.find((b) => b.id === stuck.id)).toBeDefined()
  })

  it('handles multiple stuck books in one pass (mixed outcomes)', async () => {
    const a = makeBook({ uploading: true, title: 'A — no audio' })
    const b = makeBook({ uploading: true, title: 'B — has audio' })
    const c = makeBook({ uploading: true, title: 'C — no audio' })
    const d = makeBook({ title: 'D — fine' })
    await putBook(a)
    await putBook(b)
    await putBook(c)
    await putBook(d)
    await putBookAudio({
      bookId: b.id,
      blob: new Blob(['audio']),
      duration: 5,
      paragraphOffsets: [0],
      durations: [5],
      voiceId: VOICE,
      createdAt: Date.now(),
    })

    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 1, convertedToPaused: 2, transformedToPaused: 0 })

    const all = await getAllBooks()
    const ids = new Set(all.map((b) => b.id))
    expect(ids.has(a.id)).toBe(true)
    expect(ids.has(b.id)).toBe(true)
    expect(ids.has(c.id)).toBe(true)
    expect(ids.has(d.id)).toBe(true)
  })

  it('is a no-op when no books are stuck', async () => {
    const clean = makeBook({ title: 'Done' })
    await putBook(clean)
    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 0, convertedToPaused: 0, transformedToPaused: 0 })
  })

  it('is idempotent — running twice produces the same DB state', async () => {
    const stuck = makeBook({ uploading: true, title: 'Once' })
    await putBook(stuck)

    await reconcileInterruptedUploads()
    const second = await reconcileInterruptedUploads()

    expect(second).toEqual({ clearedFlags: 0, convertedToPaused: 0, transformedToPaused: 0 })
    // Book survives the sweep; only uploading was cleared.
    expect(await getAllBooks()).toHaveLength(1)
  })

  it('leaves paused books alone (uploading=false)', async () => {
    // A paused job sets uploading=false + persists the resumable spec. The
    // sweep ignores it entirely (only uploading=true books are touched).
    const paused: Book = {
      ...makeBook({ title: 'Paused Mid-Book' }),
      uploadJob: {
        voiceId: VOICE,
        cleaning: CLEANING,
        mode: 'initial',
        done: 5,
        total: 42,
        pausedAt: Date.now(),
      },
    }
    await putBook(paused)

    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 0, convertedToPaused: 0, transformedToPaused: 0 })

    const refreshed = await getBook(paused.id)
    expect(refreshed).toBeDefined()
    expect(refreshed?.uploadJob).toBeDefined()
    expect(refreshed?.uploadJob?.done).toBe(5)
  })
})
