import { describe, expect, it } from 'vitest'
import { getCachedParagraphIds } from '../audio-cache'
import { deleteBookAudio, getBookAudio } from '../book-audio'
import {
  deleteAudioCacheKeys,
  deleteBookCascade,
  getAllBooks,
  getAudioCacheKeysByBook,
  getBook,
  getBookFile,
  getChaptersByBook,
  getMostRecentBook,
  putBook,
  putChapters,
  replaceBookChapters,
  updateBookProcessing,
  updateBookProgress,
  updateParagraph,
} from '../db'
import { bookTransformManager } from '../transform/manager'
import { uploadManager } from '../upload/manager'
import type {
  BookTransformState,
  CancelForBookResult,
  LibraryDatasource,
  SynthPipeline,
} from './types'

/**
 * Contract tests for the datasource seam. These are compile-time parity
 * fences: each assignment only typechecks when the interface member's
 * signature matches the existing lib capability it delegates to, so a
 * drift in either direction breaks this file (not a runtime call site).
 */

/** The exact library surface — pinned so interface growth is a deliberate act. */
const libraryKeys = [
  'deleteAudioCacheKeys',
  'deleteBookAudio',
  'deleteBookCascade',
  'getAllBooks',
  'getAudioCacheKeysByBook',
  'getBook',
  'getBookAudio',
  'getBookFile',
  'getCachedParagraphIds',
  'getChaptersByBook',
  'getMostRecentBook',
  'putBook',
  'putChapters',
  'replaceBookChapters',
  'updateBookProcessing',
  'updateBookProgress',
  'updateParagraph',
] as const

const transformKeys = [
  'cancelTransform',
  'cancelTransformForBook',
  'getTransformState',
  'pauseTransform',
  'resumeTransform',
  'startTransform',
  'subscribeTransform',
] as const

type JobSlice = Pick<
  SynthPipeline,
  | 'canPause'
  | 'canRetry'
  | 'cancel'
  | 'cancelForBook'
  | 'dismiss'
  | 'getState'
  | 'isActive'
  | 'isRecovering'
  | 'pause'
  | 'resume'
  | 'retry'
  | 'startJob'
  | 'subscribe'
>

type TransformSlice = Pick<SynthPipeline, (typeof transformKeys)[number]>

describe('datasource types — LibraryDatasource', () => {
  it('is implementable by pure delegation to lib/db + audio helpers', () => {
    const local: LibraryDatasource = {
      deleteAudioCacheKeys,
      deleteBookAudio,
      deleteBookCascade,
      getAllBooks,
      getAudioCacheKeysByBook,
      getBook,
      getBookAudio,
      getBookFile,
      getChaptersByBook,
      getCachedParagraphIds,
      getMostRecentBook,
      putBook,
      putChapters,
      replaceBookChapters,
      updateBookProcessing,
      updateBookProgress,
      updateParagraph,
    }
    expect(Object.keys(local).sort()).toEqual([...libraryKeys])
    expect(local.getAllBooks).toBe(getAllBooks)
    expect(local.deleteBookCascade).toBe(deleteBookCascade)
  })
})

describe('datasource types — SynthPipeline', () => {
  it('job-control slice is satisfied by uploadManager as-is', () => {
    const job: JobSlice = uploadManager
    expect(job.getState().type).toBe('idle')
  })

  it('transform-control slice is satisfiable by name-mapped delegation to bookTransformManager', () => {
    const transform: TransformSlice = {
      cancelTransform: bookTransformManager.cancel,
      cancelTransformForBook: bookTransformManager.cancelForBook,
      getTransformState: bookTransformManager.getState,
      pauseTransform: bookTransformManager.pause,
      resumeTransform: bookTransformManager.resume,
      startTransform: bookTransformManager.start,
      subscribeTransform: bookTransformManager.subscribe,
    }
    expect(Object.keys(transform).sort()).toEqual([...transformKeys])
    const state: BookTransformState = transform.getTransformState()
    expect(state.type).toBe('idle')
  })

  it('cancelForBook results use the shared blocked/cancelled/no-op union', () => {
    const results: CancelForBookResult[] = [
      { type: 'cancelled' },
      { type: 'no-op' },
      { type: 'blocked', activeBookTitle: 'A Book' },
    ]
    expect(results.map((r) => r.type)).toEqual(['cancelled', 'no-op', 'blocked'])
  })
})
