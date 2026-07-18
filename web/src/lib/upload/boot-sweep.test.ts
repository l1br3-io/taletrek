import { beforeEach, describe, expect, it } from 'vitest'
import type { Book } from '../../types'
import { newBookId } from '../../types'
import { putBookAudio } from '../book-audio'
import { _clearDBForTests, _resetDBForTests, getAllBooks, getBook, putBook } from '../db'
import { reconcileInterruptedUploads } from './boot-sweep'

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

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('reconcileInterruptedUploads', () => {
  it('deletes books stuck in uploading state with no audio (fresh-upload contract)', async () => {
    const stuck = makeBook({ uploading: true, title: 'Interrupted' })
    await putBook(stuck)
    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 0, deletedIncomplete: 1 })
    expect(await getBook(stuck.id)).toBeUndefined()
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
      voiceId: 'voice' as never,
      createdAt: Date.now(),
    })

    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 1, deletedIncomplete: 0 })

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
    expect(all.find((b) => b.id === stuck.id)).toBeUndefined()
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
      voiceId: 'voice' as never,
      createdAt: Date.now(),
    })

    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 1, deletedIncomplete: 2 })

    const all = await getAllBooks()
    const ids = new Set(all.map((b) => b.id))
    expect(ids.has(a.id)).toBe(false)
    expect(ids.has(b.id)).toBe(true)
    expect(ids.has(c.id)).toBe(false)
    expect(ids.has(d.id)).toBe(true)
  })

  it('is a no-op when no books are stuck', async () => {
    const clean = makeBook({ title: 'Done' })
    await putBook(clean)
    const report = await reconcileInterruptedUploads()
    expect(report).toEqual({ clearedFlags: 0, deletedIncomplete: 0 })
  })

  it('is idempotent — running twice produces the same DB state', async () => {
    const stuck = makeBook({ uploading: true, title: 'Once' })
    await putBook(stuck)

    await reconcileInterruptedUploads()
    const second = await reconcileInterruptedUploads()

    expect(second).toEqual({ clearedFlags: 0, deletedIncomplete: 0 })
    expect(await getAllBooks()).toHaveLength(0)
  })
})
