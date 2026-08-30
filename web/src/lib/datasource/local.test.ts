import { beforeEach, describe, expect, it } from 'vitest'
import { newBookId } from '../../types'
import { _clearDBForTests, _resetDBForTests, getAllBooks } from '../db'
import { localDatasource } from './local'

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('localDatasource', () => {
  it('exposes every LibraryDatasource member', () => {
    const members: Array<keyof typeof localDatasource> = [
      'getAllBooks',
      'getBook',
      'getMostRecentBook',
      'putBook',
      'deleteBookCascade',
      'updateBookProgress',
      'getChaptersByBook',
      'putChapters',
      'replaceBookChapters',
      'updateParagraph',
      'getBookFile',
      'getCachedParagraphIds',
      'getBookAudio',
      'getAudioCacheKeysByBook',
      'deleteAudioCacheKeys',
      'deleteBookAudio',
      'getAudioCacheSize',
      'clearAudioCache',
      'clearSegmentCache',
      'evictAudioCacheToBudget',
      'clearAllStores',
      'exportBackup',
      'importBackup',
    ]
    for (const member of members) {
      expect(typeof localDatasource[member], member).toBe('function')
    }
  })

  it('delegates book writes/reads to lib/db', async () => {
    const id = newBookId()
    await localDatasource.putBook({
      id,
      title: 'Delegated',
      format: 'txt',
      chapterCount: 1,
      createdAt: 1,
      updatedAt: 2,
    })
    expect((await getAllBooks()).map((b) => b.id)).toEqual([id])
    expect((await localDatasource.getBook(id))?.title).toBe('Delegated')
  })

  it('clears the legacy segment store through clearSegmentCache', async () => {
    const removed = await localDatasource.clearSegmentCache()
    expect(typeof removed).toBe('number')
  })
})
