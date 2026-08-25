/**
 * Local implementation of the datasource seam (ADR-0014): the unchanged
 * offline-first IndexedDB PWA behind the `LibraryDatasource` / `SynthPipeline`
 * interfaces. Pure delegation — every member forwards to the lib module that
 * already owns the logic (managers keep their direct `lib/db` access; they ARE
 * this implementation), so load-bearing semantics — `deleteBookCascade`
 * atomicity, `uploadJob` persistence (G24), resume/boot-sweep behavior (G18) —
 * are preserved by construction.
 */

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
import { ingestBook } from '../ingest'
import { reparseChapters } from '../reprocess'
import { bookTransformManager } from '../transform/manager'
import { uploadManager } from '../upload/manager'
import type { LibraryDatasource, SynthPipeline } from './types'

export const localDatasource: LibraryDatasource = {
  deleteAudioCacheKeys,
  deleteBookAudio,
  deleteBookCascade,
  getAllBooks,
  getAudioCacheKeysByBook,
  getBook,
  getBookAudio,
  getBookFile,
  getCachedParagraphIds,
  getChaptersByBook,
  getMostRecentBook,
  putBook,
  putChapters,
  replaceBookChapters,
  updateBookProcessing,
  updateBookProgress,
  updateParagraph,
}

export const localSynthPipeline: SynthPipeline = {
  ingestBook,
  reparseChapters,
  startJob: (spec) => uploadManager.startJob(spec),
  isActive: () => uploadManager.isActive(),
  resume: (bookId) => uploadManager.resume(bookId),
  pause: () => uploadManager.pause(),
  canPause: () => uploadManager.canPause(),
  cancel: () => uploadManager.cancel(),
  retry: () => uploadManager.retry(),
  canRetry: () => uploadManager.canRetry(),
  dismiss: () => uploadManager.dismiss(),
  isRecovering: () => uploadManager.isRecovering(),
  cancelForBook: (bookId) => uploadManager.cancelForBook(bookId),
  subscribe: uploadManager.subscribe,
  getState: uploadManager.getState,
  startTransform: (spec, deps) => bookTransformManager.start(spec, deps),
  resumeTransform: (bookId, deps) => bookTransformManager.resume(bookId, deps),
  pauseTransform: () => bookTransformManager.pause(),
  cancelTransform: () => bookTransformManager.cancel(),
  cancelTransformForBook: (bookId) => bookTransformManager.cancelForBook(bookId),
  subscribeTransform: bookTransformManager.subscribe,
  getTransformState: bookTransformManager.getState,
}
