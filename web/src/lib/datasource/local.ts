/**
 * Local implementation of the datasource seam: the IndexedDB reader behind
 * the `LibraryDatasource` interface. Pure delegation — every member forwards
 * to the lib module that already owns the logic, so load-bearing semantics
 * (`deleteBookCascade` atomicity) are preserved by construction.
 */

import { getCachedParagraphIds } from '../audio-cache'
import { exportBackup, importBackup } from '../backup'
import { deleteBookAudio, getBookAudio } from '../book-audio'
import {
  clearAllStores,
  clearAudioCache,
  clearSegmentCache,
  deleteAudioCacheKeys,
  deleteBookCascade,
  evictAudioCacheToBudget,
  getAllBooks,
  getAudioCacheKeysByBook,
  getAudioCacheSize,
  getBook,
  getBookFile,
  getChaptersByBook,
  getMostRecentBook,
  putBook,
  putChapters,
  replaceBookChapters,
  updateBookProgress,
  updateParagraph,
} from '../db'
import type { LibraryDatasource } from './types'

export { AUDIO_CACHE_BUDGET_BYTES } from '../db'

export const localDatasource: LibraryDatasource = {
  clearAllStores,
  clearAudioCache,
  clearSegmentCache,
  deleteAudioCacheKeys,
  deleteBookAudio,
  deleteBookCascade,
  evictAudioCacheToBudget,
  exportBackup,
  getAllBooks,
  getAudioCacheKeysByBook,
  getAudioCacheSize,
  getBook,
  getBookAudio,
  getBookFile,
  getCachedParagraphIds,
  getChaptersByBook,
  getMostRecentBook,
  importBackup,
  putBook,
  putChapters,
  replaceBookChapters,
  updateBookProgress,
  updateParagraph,
}
