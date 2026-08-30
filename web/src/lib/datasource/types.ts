/**
 * Datasource seam — the boundary between the UI and wherever books,
 * chapters, and audio live.
 *
 * Post-pivot (ADR-0015) there is exactly one implementation: the local
 * IndexedDB reader (`local.ts`). The seam stays so a future host (sync
 * server, native shell) can slot in without touching callers.
 *
 * Contract: UI (`routes/`, `components/`, `hooks/`, `context/`) imports
 * data access from `lib/datasource` only — never `lib/db` directly. Lib
 * internals keep direct `lib/db` access: they sit behind this seam as the
 * local implementation. Every member maps 1:1 onto an existing `lib/db`
 * capability with a live UI caller — no speculative surface.
 */

import type { Book, BookFile, BookId, BookPosition, Chapter, ChapterId, VoiceId } from '../../types'
import type { ImportOptions, ImportReport } from '../backup'
import type { BookAudio } from '../book-audio'

export type { BookAudio, ImportOptions, ImportReport }

/**
 * Library reads/writes the UI performs: books, chapters, original files,
 * and derived audio. All operations are whole-value (no partial patches
 * except where named).
 */
export interface LibraryDatasource {
  // --- books ---
  /** All books, newest-first by `updatedAt`. */
  getAllBooks(): Promise<Book[]>
  /** Read a book by id, or `undefined` if absent. */
  getBook(id: BookId): Promise<Book | undefined>
  /** Most-recently-updated book, or `undefined` when none exist. */
  getMostRecentBook(): Promise<Book | undefined>
  /** Write a book record (insert or overwrite). */
  putBook(book: Book): Promise<void>
  /**
   * Remove a book with all derived data (chapters, file, cached audio,
   * segments, whole-book audio) in one atomic cascade.
   */
  deleteBookCascade(id: BookId): Promise<void>
  /** Lightweight progress write — sets position + fraction, bumps `updatedAt`. */
  updateBookProgress(id: BookId, position: BookPosition, progressFraction: number): Promise<void>

  // --- chapters ---
  /** All chapters for a book, ordered by chapter index. */
  getChaptersByBook(bookId: BookId): Promise<Chapter[]>
  /** Write chapters (insert or overwrite). */
  putChapters(chapters: Chapter[]): Promise<void>
  /** Atomically replace all chapters for a book (outline regeneration). */
  replaceBookChapters(bookId: BookId, newChapters: Chapter[]): Promise<void>
  /**
   * Overwrite one paragraph's text within a chapter. Returns the updated
   * chapter, or `undefined` if the chapter or index is out of range.
   */
  updateParagraph(
    chapterId: ChapterId,
    paragraphIndex: number,
    text: string,
  ): Promise<Chapter | undefined>

  // --- original file ---
  /**
   * The book's original uploaded file, or `undefined` when evicted/never
   * stored.
   */
  getBookFile(id: BookId): Promise<BookFile | undefined>

  // --- derived audio: probing + whole-book read ---
  /**
   * Positional paragraph ids (`${chapterId}:${index}`) with synthesized
   * audio available for a given voice — drives the reader's buffered
   * indicators. Pass cleaned chapters so keys match synth-time derivation.
   */
  getCachedParagraphIds(bookId: BookId, voiceId: VoiceId, chapters: Chapter[]): Promise<Set<string>>
  /** The book's whole-book audio record (mobile preloaded player), if encoded. */
  getBookAudio(bookId: BookId): Promise<BookAudio | undefined>

  // --- derived audio: invalidation ---
  /** All audio-cache keys owned by a book. */
  getAudioCacheKeysByBook(bookId: BookId): Promise<string[]>
  /** Delete specific audio-cache entries by key. Returns the count removed. */
  deleteAudioCacheKeys(keys: string[]): Promise<number>
  /** Drop the book's whole-book audio record (invalidated by text changes). */
  deleteBookAudio(bookId: BookId): Promise<void>

  // --- storage management (Settings) ---
  /** Total bytes currently held in the audio cache. */
  getAudioCacheSize(): Promise<number>
  /** Delete every audio-cache entry. Returns the count removed. */
  clearAudioCache(): Promise<number>
  /** Delete every audio-segment cache entry. Returns the count removed. */
  clearSegmentCache(): Promise<number>
  /**
   * Evict least-recently-used audio-cache entries until the total is at or
   * under `budgetBytes`. Returns the count evicted.
   */
  evictAudioCacheToBudget(budgetBytes: number): Promise<number>
  /**
   * Wipe every datasource-owned store (books, chapters, files, audio cache,
   * segments, …) in one pass. The Settings device-wipe flow calls this
   * alongside clearing SW/caches/web-storage, then reloads.
   */
  clearAllStores(): Promise<void>

  // --- backup & transfer (Settings) ---
  /**
   * Full data export (settings + books + chapters + files; audio cache
   * excluded — it re-enters via bundle import) as a JSON `Blob`.
   */
  exportBackup(): Promise<Blob>
  /**
   * Import a backup blob. Non-destructive per book (existing ids skipped);
   * settings overwritten by default. Throws `CorruptBackupError` /
   * `BackupTooLargeError` (re-exported from `lib/datasource`).
   */
  importBackup(blob: Blob, opts?: ImportOptions): Promise<ImportReport>
}
