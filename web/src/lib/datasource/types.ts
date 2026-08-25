/**
 * Datasource seam — the boundary between the UI and wherever books,
 * chapters, audio, and synthesis actually live (ADR-0014).
 *
 * Contract:
 * - UI (`routes/`, `components/`, `hooks/`, `context/`) imports data access
 *   from `lib/datasource` only — never `lib/db`, the upload/transform
 *   managers, or `lib/ingest` directly. Lib internals keep direct `lib/db`
 *   access: they sit behind this seam as the local implementation.
 * - Settings and the secure keyring stay **out**: they remain client-side
 *   IndexedDB in both modes (`context/settings.tsx` + `lib/ai/secure-keyring`
 *   consumers are the locked allowlist).
 * - Implementations: `LocalDatasource` (IndexedDB, the unchanged offline-first
 *   PWA) and `ServerDatasource` (same-origin HTTP, the server-hosted shape).
 *   Resolved once at boot by `resolve.ts` — never per-call.
 * - Methods return plain promises matching existing call sites; the UI keeps
 *   owning its variant states (`{ type: 'loading' } | …`). Job and transform
 *   progress use the shared variant unions re-exported below.
 *
 * Every member maps 1:1 onto an existing `lib/db` / manager capability with a
 * live UI caller — no speculative surface. Extend only alongside a caller.
 */

import type { Book, BookFile, BookId, BookPosition, Chapter, ChapterId, VoiceId } from '../../types'
import type { AiSettings, AppliedProcessing, TransformDefinition } from '../ai/types'
import type { ImportOptions, ImportReport } from '../backup'
import type { BookAudio } from '../book-audio'
import type { IngestResult } from '../ingest'
import type { BookTransformState, TransformJobSpec } from '../transform/manager'
import type { JobSpec, JobState } from '../upload/manager'

export type {
  BookAudio,
  BookTransformState,
  ImportOptions,
  ImportReport,
  IngestResult,
  JobSpec,
  JobState,
  TransformJobSpec,
}

/**
 * Discriminated result of cancelling whatever a pipeline is running for a
 * book (used by library delete). `'blocked'` means another book's job is
 * active — the caller should refuse the delete and surface why.
 */
export type CancelForBookResult =
  | { type: 'cancelled' }
  | { type: 'no-op' }
  | { type: 'blocked'; activeBookTitle: string }

/** Client-side inputs a whole-book transform run needs (AI settings are
 * always local — keys never leave the browser, in either mode). */
export interface TransformRunDeps {
  ai: AiSettings
  defs: TransformDefinition[]
  synthEnabled: boolean
}

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
  /** Set (or clear, via `undefined`) a book's applied-processing record. */
  updateBookProcessing(id: BookId, processing: AppliedProcessing | undefined): Promise<void>

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
   * stored. Outline re-detection reads this; absence degrades those flows.
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

  // --- derived audio: invalidation (transform → resynth) ---
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
   * alongside clearing voices/SW/caches/web-storage, then reloads.
   */
  clearAllStores(): Promise<void>

  // --- backup & transfer (Settings) ---
  /**
   * Full data export (settings + books + chapters + files; audio cache
   * excluded — it regenerates) as a JSON `Blob`.
   */
  exportBackup(): Promise<Blob>
  /**
   * Import a backup blob. Non-destructive per book (existing ids skipped);
   * settings overwritten by default. Throws `CorruptBackupError` /
   * `BackupTooLargeError` (re-exported from `lib/datasource`).
   */
  importBackup(blob: Blob, opts?: ImportOptions): Promise<ImportReport>
}

/**
 * Upload/transform/synth orchestration the UI triggers. The job half
 * (start/pause/resume/cancel + state) mirrors the local upload manager;
 * the transform half mirrors the streaming book-transform manager. State
 * is external-store compatible (`subscribe` + `get…State`) for
 * `useSyncExternalStore`.
 */
export interface SynthPipeline {
  // --- upload + synth job ---
  /**
   * Parse an uploaded file in workers and persist the resulting book +
   * chapters (wherever "persist" lives in this mode). Throws
   * `UnsupportedFileError` for unrecognized types; propagates parse errors.
   */
  ingestBook(file: File): Promise<IngestResult>
  /**
   * Start a synthesis job for a known book + chapters. `'initial'` mode
   * cascades on failure; `'resynth'` keeps the book and offers retry.
   * Throws if a job is already active.
   */
  startJob(spec: JobSpec): void
  /** True while a job is running (or tearing down after cancel/pause). */
  isActive(): boolean
  /** Resume the paused job persisted on a book record. No-op if absent/active. */
  resume(bookId: BookId): Promise<void>
  /** Request a cooperative pause — observed at the next paragraph boundary. */
  pause(): void
  /** Whether the active job can be paused (for UI affordances). */
  canPause(): boolean
  /** Cancel the active job. */
  cancel(): void
  /** Re-run the last job spec (valid from retryable error states). */
  retry(): void
  /** Whether a retry is available in the current state. */
  canRetry(): boolean
  /** Dismiss a settled (done/error/paused) job banner. */
  dismiss(): void
  /** True while recovering from a long tab-hide (presumed phone lock). */
  isRecovering(): boolean
  /**
   * Cancel any in-progress job for this book and wait for settle, so a
   * cascade-delete can't race the pipeline's writes. `'blocked'` when
   * another book's job is active.
   */
  cancelForBook(bookId: BookId): Promise<CancelForBookResult>
  /** External-store subscription for job-state changes. */
  subscribe(listener: () => void): () => void
  /** Current job state (variant union — see `JobState`). */
  getState(): JobState

  // --- whole-book AI transform (streaming) ---
  /**
   * Submit a streaming whole-book transform. Operational failures surface
   * via `getTransformState()` (error variant), not throws. When synth is
   * enabled the pipeline chains its own resynth on completion.
   */
  startTransform(spec: TransformJobSpec, deps: TransformRunDeps): Promise<void>
  /** Resume the paused transform persisted on a book record. */
  resumeTransform(bookId: BookId, deps: TransformRunDeps): Promise<void>
  /** Pause the running transform (cooperative — commits keep). */
  pauseTransform(): void
  /** Cancel the running or paused transform. Already-committed chapters keep. */
  cancelTransform(): Promise<void>
  /** As `cancelForBook`, for the transform pipeline (delete flow). */
  cancelTransformForBook(bookId: BookId): Promise<CancelForBookResult>
  /** External-store subscription for transform-state changes. */
  subscribeTransform(listener: () => void): () => void
  /** Current transform state (variant union — see `BookTransformState`). */
  getTransformState(): BookTransformState

  // --- re-processing ---
  /**
   * Recover pristine chapters for a book — locally by re-parsing the stored
   * original file (throws `OriginalUnavailableError` when evicted). Used by
   * reprocess flows so transforms don't stack on prior output.
   */
  reparseChapters(bookId: BookId): Promise<Chapter[]>
}
