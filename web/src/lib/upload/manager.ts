import type { Book, BookId, Chapter, PersistedUploadJob, VoiceId } from '../../types'
import { concatClient } from '../audio/concat-client'
import { putBookAudio } from '../book-audio'
import { cleanChapters } from '../clean'
import type { CleaningConfig } from '../clean/types'
import { getBook, getChaptersByBook, getSetting, putBook } from '../db'
import {
  evictAudioCacheToBudget,
  isQuotaExceededError,
  setPinnedAudioCacheBookId,
} from '../db/audio-cache'
import { formatError } from '../format-error'
import { isMobileDevice } from '../platform'
import { type PlaybackEngineSetting, resolveMobileEngine } from '../playback/engines'
import type { ParagraphLocation, ParagraphPreSynthInfo } from '../pre-synth'
import { preSynthesizeBook } from '../pre-synth'
import { ttsClient } from '../tts/client'
import { PoolEngine } from '../tts/pool'
import { preferredPoolSize } from '../tts/pool-size'
import { acquireUploadWakeLock } from '../wake-lock'

/**
 * Distinguishes a fresh-upload synth (a failure here is fatal — the book has no
 * audio yet, so we cascade-delete it back to a clean slate) from a re-synth
 * after a transform or manual re-synthesize (a failure here must NOT delete the
 * book — the user's text is intact and they should be able to retry).
 */
export type JobMode = 'initial' | 'resynth'

export type JobState =
  | { type: 'idle' }
  | { type: 'voiceDownload'; book: Book; fraction: number; mode: JobMode }
  | {
      type: 'synthesizing'
      book: Book
      done: number
      total: number
      synthesizedParagraphIds: Set<string>
      mode: JobMode
      /**
       * Paragraph currently (or last) being synthesized. Updated per-¶ via
       * `onParagraphStart` so the banner can show "ch. N, ¶ X/Y". Also
       * mirrored onto `book.uploadJob` to survive tab eviction.
       */
      current?: ParagraphLocation
    }
  | { type: 'encoding'; book: Book; progress?: number; mode: JobMode }
  | { type: 'cancelling'; book: Book; mode: JobMode }
  | { type: 'paused'; book: Book; done: number; total: number; mode: JobMode }
  | { type: 'done'; book: Book; mode: JobMode }
  | { type: 'error'; book: Book; message: string; mode: JobMode; retryable?: boolean }

export interface JobSpec {
  book: Book
  chapters: Chapter[]
  voiceId: VoiceId
  cleaning: CleaningConfig
  /**
   * `'initial'` (default) cascades a book delete on non-abort failure (the
   * fresh-upload contract). `'resynth'` keeps the book and offers a retry —
   * used after transforms and manual re-synthesize.
   */
  mode?: JobMode
}

interface ParagraphRef {
  id: string
}

function paragraphRefs(chapters: Chapter[]): ParagraphRef[] {
  const refs: ParagraphRef[] = []
  for (const ch of chapters) {
    ch.paragraphs.forEach((text, index) => {
      if (text.trim()) refs.push({ id: `${ch.id}:${index}` })
    })
  }
  return refs
}

/**
 * Whether the resolved mobile playback engine is FFmpeg (ADR-0010 / M11). Reads
 * the live setting from IDB — the Web Audio engine performs no encode, so the
 * whole-book m4a path runs only when the FFmpeg engine is selected/resolved.
 */
async function shouldEncodeForFfmpegEngine(): Promise<boolean> {
  const stored = await getSetting<{ playbackEngine?: PlaybackEngineSetting }>('app')
  return resolveMobileEngine(stored?.playbackEngine ?? 'auto') === 'ffmpeg'
}

/** AAC-LC mono bitrate used by the mobile whole-book encode (bits/s). */
const MOBILE_AAC_BITRATE = 64_000
const MOBILE_AAC_BYTES_PER_SECOND = MOBILE_AAC_BITRATE / 8
/**
 * Maximum estimated size for a whole-book mobile encode. Above this we skip
 * the encode and fall back to per-paragraph desktop-style playback on mobile.
 * 200 MB @ 64kbps ≈ 7 hours of speech.
 */
const MAX_MOBILE_M4A_BYTES = 200 * 1024 * 1024

async function clearUploadingFlag(bookId: BookId): Promise<void> {
  return enqueueBookWrite(bookId, async () => {
    const book = await getBook(bookId)
    if (book) {
      delete book.uploading
      book.updatedAt = Date.now()
      await putBook(book)
    }
  })
}

/**
 * Per-book serialization queue for `uploadJob` writes. Multiple writers
 * (runJob-start `persistUploadJob`, per-¶ `patchUploadJob`, cancel cleanup
 * `clearUploadJob`) all do read-modify-write on the same book record; without
 * serialization they interleave and clobber each other (e.g. `patchUploadJob`
 * reads `uploading=true`, `clearUploadingFlag` clears it, then `patchUploadJob`
 * commits its stale `true`). Chaining writes through one promise-per-book
 * guarantees atomicity without a single IDB transaction wrapper.
 */
const bookWriteQueue = new Map<BookId, Promise<void>>()

function enqueueBookWrite(bookId: BookId, fn: () => Promise<void>): Promise<void> {
  const prev = bookWriteQueue.get(bookId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // Drop the queue entry once settled so we don't hold a stale promise (and
  // any attached rejection) forever.
  const cleanup = () => {
    if (bookWriteQueue.get(bookId) === next) bookWriteQueue.delete(bookId)
  }
  next.then(cleanup, cleanup)
  bookWriteQueue.set(bookId, next)
  return next
}

/**
 * Persist a job's resumable spec onto the book record. Used in two contexts:
 *
 * - **Explicit pause** (`clearUploading = true`, the default): sets
 *   `uploading = false` so ADR-0009's boot sweep ignores the book. The book
 *   becomes a normal Paused card in the library.
 * - **runJob start** (`clearUploading = false`): writes the initial spec so
 *   an interrupted initial upload (iOS tab eviction, crash) survives as a
 *   resumable Paused book, but keeps `uploading = true` so the boot sweep
 *   still detects the interruption. `done`/`lastFlatIndex`/etc. are then
 *   patched per-¶ via {@link patchUploadJob}.
 */
async function persistUploadJob(
  bookId: BookId,
  job: PersistedUploadJob,
  clearUploading = true,
): Promise<void> {
  return enqueueBookWrite(bookId, async () => {
    const book = await getBook(bookId)
    if (!book) return
    book.uploadJob = job
    if (clearUploading) book.uploading = false
    book.updatedAt = Date.now()
    await putBook(book)
  })
}

/**
 * Patch specific fields on the persisted `uploadJob` without disturbing the
 * rest, and **without touching `uploading`**. Used for per-¶ progress updates
 * mid-synth — the book stays `uploading: true` so the boot sweep won't think
 * the job completed. Re-reads the book each call because other IDB writers
 * (e.g. `clearUploadingFlag`) may have touched it between calls. Serialized
 * via {@link enqueueBookWrite} so concurrent patches don't clobber each other.
 */
async function patchUploadJob(
  bookId: BookId,
  patch: Partial<PersistedUploadJob>,
  /** Skip if the current job doesn't match `mode`/`voiceId` — a concurrent job started. */
  expected: { voiceId: VoiceId; mode: JobMode },
): Promise<void> {
  return enqueueBookWrite(bookId, async () => {
    const book = await getBook(bookId)
    if (!book?.uploadJob) return
    if (book.uploadJob.voiceId !== expected.voiceId || book.uploadJob.mode !== expected.mode) return
    book.uploadJob = { ...book.uploadJob, ...patch }
    book.updatedAt = Date.now()
    await putBook(book)
  })
}

/** Clear a paused job from the book record (on resume or completion). */
async function clearUploadJob(bookId: BookId): Promise<void> {
  return enqueueBookWrite(bookId, async () => {
    const book = await getBook(bookId)
    if (!book) return
    delete book.uploadJob
    book.updatedAt = Date.now()
    await putBook(book)
  })
}

/**
 * Lazy parallel-synthesis pool (ADR-0011). Pre-synth only — the singleton
 * `ttsClient` still backs reader/playback per-paragraph synth and voice
 * management. Constructed on first use so the cost (one worker per logical
 * core, or 2 on mobile) is paid only when a book actually uploads. Each
 * worker lazy-loads its Piper model from OPFS on first synth (the upload
 * pipeline pre-downloads the voice via the singleton before pre-synth starts,
 * so workers never hit the network).
 */
let preSynthPool: PoolEngine | null = null
function getPreSynthPool(): PoolEngine {
  if (!preSynthPool) {
    preSynthPool = new PoolEngine(preferredPoolSize(), ttsClient)
  }
  return preSynthPool
}

class UploadManager {
  private state: JobState = { type: 'idle' }
  private readonly listeners = new Set<() => void>()
  private abortController: AbortController | null = null
  private lastSpec: (JobSpec & { mode: JobMode }) | null = null
  /** Set by `pause()` so the abort finalization knows to persist + go 'paused'. */
  private pauseRequested = false
  /** Last-reported synth progress, captured so pause-from-any-state has done/total. */
  private lastSynthDone = 0
  private lastSynthTotal = 0

  getState = (): JobState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  isActive(): boolean {
    return (
      this.state.type === 'voiceDownload' ||
      this.state.type === 'synthesizing' ||
      this.state.type === 'encoding' ||
      this.state.type === 'cancelling'
    )
  }

  startJob(spec: JobSpec): void {
    if (this.isActive()) {
      throw new Error('A synthesis job is already running')
    }
    const resolved: JobSpec & { mode: JobMode } = { ...spec, mode: spec.mode ?? 'initial' }
    this.lastSpec = resolved
    this.abortController = new AbortController()
    void this.runJob(resolved)
  }

  cancel(): void {
    if (!this.isActive() || !this.abortController) return
    const { book, mode } = this.state as {
      book: Book
      mode: JobMode
    }
    console.log('[taletrek] upload: cancel requested', {
      title: book.title,
      stage: this.state.type,
      mode,
    })
    // Flip to `cancelling` immediately so the UI can reflect the request
    // before the in-flight async work observes the abort and resolves.
    this.setState({ type: 'cancelling', book, mode })
    this.abortController.abort()
  }

  /**
   * Pause the active job (ADR-0010 / M11). Cooperative — the abort is observed
   * at the next paragraph boundary (the in-flight Piper inference is not
   * interruptible), then the spec is persisted on the book record with
   * `uploading = false` so the boot sweep (ADR-0009) ignores it. No-op unless
   * a job is active and not already pausing.
   */
  pause(): void {
    if (!this.isActive() || this.pauseRequested || !this.abortController) return
    const { book } = this.state as { book: Book }
    console.log('[taletrek] upload: pause requested', {
      title: book.title,
      stage: this.state.type,
    })
    this.pauseRequested = true
    this.abortController.abort()
  }

  /** Whether the current job can be paused (for UI affordances). */
  canPause(): boolean {
    return this.isActive() && !this.pauseRequested
  }

  /**
   * Resume a paused job. Reloads chapters from IDB, clears the persisted spec,
   * re-sets `uploading = true`, and re-runs the spec — the M8 content-addressed
   * cache fast-forwards through already-synthesized paragraphs. No-op if a job
   * is already active or the book has no paused spec.
   */
  async resume(bookId: BookId): Promise<void> {
    if (this.isActive()) return
    const book = await getBook(bookId)
    const job = book?.uploadJob
    if (!book || !job) return
    console.log('[taletrek] upload: resume', {
      title: book.title,
      done: job.done,
      total: job.total,
      mode: job.mode,
    })
    const chapters = await getChaptersByBook(bookId)
    await clearUploadJob(bookId)
    // Re-set the uploading flag so the library badges the book as in-progress.
    book.uploading = true
    book.updatedAt = Date.now()
    await putBook(book)
    this.startJob({
      book,
      chapters,
      voiceId: job.voiceId,
      cleaning: job.cleaning,
      mode: job.mode,
    })
  }

  dismiss(): void {
    if (this.state.type === 'done' || this.state.type === 'error' || this.state.type === 'paused') {
      this.setState({ type: 'idle' })
    }
  }

  /**
   * Re-run the last job spec. Valid from a `resynth`-mode error or from a
   * transient storage error in `initial` mode. No-op otherwise (e.g. while
   * active, or when the last job succeeded).
   */
  retry(): void {
    if (this.state.type !== 'error' || !this.canRetry()) return
    if (this.isActive() || !this.lastSpec) return
    this.startJob(this.lastSpec)
  }

  /** Whether a retry is available in the current state (for UI affordances). */
  canRetry(): boolean {
    return (
      this.state.type === 'error' &&
      (this.state.mode === 'resynth' || !!this.state.retryable) &&
      this.lastSpec !== null
    )
  }

  _resetForTests(): void {
    this.abortController?.abort()
    this.abortController = null
    this.lastSpec = null
    this.pauseRequested = false
    this.lastSynthDone = 0
    this.lastSynthTotal = 0
    this.state = { type: 'idle' }
  }

  /**
   * Build the `synthesizedParagraphIds` set from `refs[0..done)`. Extracted so
   * both `onParagraphStart` and `onProgress` can re-derive it without duplicating
   * the slice — the set has to be a fresh instance each setState call so React
   * sees a new identity.
   */
  private collectSynthesizedIds(refs: ParagraphRef[], done: number): Set<string> {
    return new Set(refs.slice(0, done).map((r) => r.id))
  }

  private setState(next: JobState): void {
    this.state = next
    for (const ln of this.listeners) ln()
  }

  private async runJob(spec: JobSpec & { mode: JobMode }): Promise<void> {
    const { book, chapters, voiceId, cleaning, mode } = spec
    const signal = this.abortController?.signal
    const cleaned = cleanChapters(chapters, cleaning)
    const refs = paragraphRefs(cleaned)
    const isMobile = isMobileDevice()

    // Pin this book's cache entries while the job runs so the reactive LRU
    // sweep does not evict paragraphs we are about to encode on mobile.
    setPinnedAudioCacheBookId(book.id)

    // State must flip synchronously so `startJob`'s re-entry guard sees
    // 'synthesizing' before the caller can call startJob again.
    this.lastSynthDone = 0
    this.lastSynthTotal = refs.length
    this.setState({
      type: 'synthesizing',
      book,
      done: 0,
      total: refs.length,
      synthesizedParagraphIds: new Set(),
      mode,
    })
    console.log('[taletrek] upload: runJob start', {
      title: book.title,
      mode,
      total: refs.length,
      isMobile,
    })

    // Hold a screen wake lock for the full job (synth + mobile encode) so the
    // auto-lock timer doesn't freeze the workers mid-render. Best-effort.
    const wakeLock = await acquireUploadWakeLock()

    // Persist the resumable spec from the very start (NOT only on explicit
    // pause) so an interrupted initial upload — iOS tab eviction, crash, OOM
    // — survives the ADR-0009 boot sweep as a paused book instead of being
    // cascade-deleted. `done` is bumped per-¶ below. `uploading` stays true
    // (clearUploading: false) so the sweep still detects the interruption
    // correctly — a clean completion clears both `uploading` and `uploadJob`.
    //
    // Persisted INSIDE the try (after wake lock acquire) so an early-abort
    // (e.g. test teardown racing with startJob) doesn't acquire + release the
    // wake lock across a test boundary — the wake-lock acquire timing is
    // unchanged from the pre-persistence path.
    const jobSpec = { voiceId, mode }
    try {
      await persistUploadJob(
        book.id,
        {
          voiceId,
          cleaning,
          mode,
          done: 0,
          total: refs.length,
          pausedAt: Date.now(),
        },
        false,
      ).catch((err) => {
        console.warn('[taletrek] upload: could not persist initial uploadJob', err)
      })

      const preSynthPool = getPreSynthPool()
      const preSynthResult = await preSynthesizeBook({
        bookId: book.id,
        chapters: cleaned,
        voiceId,
        engine: preSynthPool,
        concurrency: preSynthPool.concurrency,
        signal,
        onVoiceDownload: (fraction) => {
          if (signal?.aborted) return
          this.setState({ type: 'voiceDownload', book, fraction, mode })
        },
        onParagraphStart: ({ flatTotal, location }) => {
          if (signal?.aborted) return
          // "Currently working on" UI hint. With concurrency > 1 multiple
          // paragraphs are in flight simultaneously; the latest dispatch is
          // the most reasonable "current" signal. The completed location is
          // tracked separately via onProgress's `completed` arg.
          this.setState({
            type: 'synthesizing',
            book,
            done: this.lastSynthDone,
            total: flatTotal,
            synthesizedParagraphIds: this.collectSynthesizedIds(refs, this.lastSynthDone),
            mode,
            current: location,
          })
        },
        onProgress: (done, total, completed) => {
          // Capture progress even during an in-flight abort so `pause` can
          // persist the correct `done` (the abort guard below prevents setState
          // from clobbering the cancelling/paused transition).
          this.lastSynthDone = done
          this.lastSynthTotal = total
          if (signal?.aborted) return
          // `completed` is the paragraph that just finished — out-of-order
          // under concurrency > 1, so don't infer it from onParagraphStart.
          this.setState({
            type: 'synthesizing',
            book,
            done,
            total,
            synthesizedParagraphIds: this.collectSynthesizedIds(refs, done),
            mode,
            current: completed,
          })
          // Single per-¶ write: bumps `done` AND records the just-completed
          // paragraph's location so a tab eviction leaves a resumable spec
          // that points at exactly where synth stopped.
          void patchUploadJob(
            book.id,
            {
              done,
              total,
              lastFlatIndex: Math.max(0, done - 1),
              lastChapterTitle: completed?.chapterTitle,
              lastParagraphInChapter: completed?.paragraphInChapter,
              lastChapterTotal: completed?.chapterTotal,
            },
            jobSpec,
          ).catch((err) => {
            console.warn('[taletrek] upload: could not patch uploadJob (progress)', err)
          })
        },
      })

      if (signal?.aborted) {
        await this.finalizeAfterAbort(spec)
        return
      }

      const resolvedFfmpeg =
        isMobile && preSynthResult.paragraphs.length > 0
          ? await shouldEncodeForFfmpegEngine()
          : false
      const estimatedM4aBytes = resolvedFfmpeg
        ? Math.ceil(
            preSynthResult.paragraphs.reduce(
              (sum, p) => sum + p.durationSeconds * MOBILE_AAC_BYTES_PER_SECOND,
              0,
            ),
          )
        : 0
      const willEncode = resolvedFfmpeg && estimatedM4aBytes <= MAX_MOBILE_M4A_BYTES
      console.log('[taletrek] upload: encode-gate decision', {
        title: book.title,
        isMobile,
        resolvedFfmpeg,
        estimatedM4aMb: Math.round(estimatedM4aBytes / 1024 / 1024),
        capMb: Math.round(MAX_MOBILE_M4A_BYTES / 1024 / 1024),
        willEncode,
      })

      if (willEncode) {
        await this.encodeBook(book, voiceId, preSynthResult.paragraphs, signal, mode)
      } else if (resolvedFfmpeg) {
        console.log(
          '[taletrek] upload: mobile encode skipped for huge book',
          book.title,
          `${Math.round(estimatedM4aBytes / 1024 / 1024)} MB estimated`,
        )
      }

      await clearUploadingFlag(book.id)
      await clearUploadJob(book.id)
      this.setState({ type: 'done', book, mode })
    } catch (error) {
      if (signal?.aborted) {
        await this.finalizeAfterAbort(spec)
      } else {
        const current = this.state
        const errorInfo = {
          title: book.title,
          stage: current.type,
          done: current.type === 'synthesizing' ? current.done : undefined,
          total: current.type === 'synthesizing' ? current.total : undefined,
          name:
            error instanceof DOMException
              ? error.name
              : error instanceof Error
                ? error.constructor.name
                : undefined,
          code: error instanceof DOMException ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }
        console.error(
          '[taletrek] upload: failed',
          {
            ...errorInfo,
            // Capture everything useful about the error for iOS debugging.
            rawName: (error as Error).name,
            rawConstructor: (error as object).constructor?.name,
            rawCode:
              error instanceof DOMException
                ? error.code
                : typeof (error as DOMException).code === 'number'
                  ? (error as DOMException).code
                  : undefined,
          },
          // Pass a pre-serialized string, not the raw error object — vConsole
          // fails to serialize DOMException prototype getters and prints the
          // `(PARSE_ERROR)` placeholder, masking the real cause. See
          // `lib/format-error.ts`.
          formatError(error),
        )

        if (mode === 'initial') {
          // Synthesis failure during fresh upload. Keep the book so the user can
          // retry — the parsed text is intact and only the audio is incomplete.
          // Cascade-deleting here was too aggressive: it would remove the book
          // mid-synthesis while the reader page is still mounted, triggering a
          // React Router error boundary and an iOS Safari tab reload.
          await clearUploadingFlag(book.id).catch(() => {})
          // Clear the partial uploadJob too — the user-facing state is
          // 'error' (with a Retry button in the banner), not 'paused' (which
          // would show a Resume button on the library card). The M8 cache
          // survives either way, so Retry fast-forwards.
          await clearUploadJob(book.id).catch(() => {})
        }
        // Resynth mode always keeps the book intact.

        this.setState({
          type: 'error',
          book,
          message: error instanceof Error ? error.message : 'Upload failed',
          mode,
          retryable: true,
        })
      }
    } finally {
      setPinnedAudioCacheBookId(null)
      await wakeLock.release()
      this.abortController = null
      // If the user cancelled but an async path didn't observe the abort
      // (e.g. the encoding phase has unconditional setState calls that may
      // have run after abort), make sure we don't strand the UI in
      // `cancelling` forever — force it back to idle. (Pause is handled in
      // `finalizeAfterAbort` at the explicit abort sites, not here.)
      if (this.state.type === 'cancelling') {
        this.setState({ type: 'idle' })
      }
      this.pauseRequested = false
    }
  }

  /**
   * Finalize an aborted run. If `pause()` was the trigger, persist the
   * resumable spec onto the book record (with `uploading = false` so ADR-0009's
   * boot sweep ignores it) and transition to `'paused'`. Otherwise (a real
   * `cancel()`) clear the partial `uploadJob` (set at runJob start) and the
   * `uploading` flag so the library card shows neither badge, then transition
   * to `'idle'` as before.
   *
   * The cancel-path cleanup is **fire-and-forget** (not awaited): the wake
   * lock release in `runJob`'s `finally` must happen synchronously after the
   * setState, or the wake-lock mock count can slip past a test boundary when
   * `_resetForTests` aborts a never-resolving job. The IDB writes complete in
   * the background; nothing reads them in the same tick.
   */
  private async finalizeAfterAbort(spec: JobSpec & { mode: JobMode }): Promise<void> {
    if (!this.pauseRequested) {
      console.log('[taletrek] upload: aborted → idle (cancel)', { title: spec.book.title })
      void clearUploadingFlag(spec.book.id).catch(() => {})
      void clearUploadJob(spec.book.id).catch(() => {})
      this.setState({ type: 'idle' })
      return
    }
    this.pauseRequested = false
    const done = this.lastSynthDone
    const total = this.lastSynthTotal
    console.log('[taletrek] upload: aborted → paused', {
      title: spec.book.title,
      done,
      total,
    })
    await persistUploadJob(spec.book.id, {
      voiceId: spec.voiceId,
      cleaning: spec.cleaning,
      mode: spec.mode,
      done,
      total,
      pausedAt: Date.now(),
    })
    this.setState({ type: 'paused', book: spec.book, done, total, mode: spec.mode })
  }

  private async encodeBook(
    book: Book,
    voiceId: VoiceId,
    paragraphs: ParagraphPreSynthInfo[],
    signal: AbortSignal | undefined,
    mode: JobMode,
  ): Promise<void> {
    this.setState({ type: 'encoding', book, mode })
    console.log('[taletrek] upload: encode start', {
      title: book.title,
      paragraphs: paragraphs.length,
    })

    await concatClient.loadCore((fraction) => {
      if (signal?.aborted) return
      this.setState({ type: 'encoding', book, progress: fraction, mode })
    })

    if (signal?.aborted) return

    this.setState({ type: 'encoding', book, progress: 1, mode })

    const keys = paragraphs.map((p) => p.cacheKey)
    const result = await concatClient.concat(keys)
    console.log('[taletrek] upload: concat done', {
      title: book.title,
      m4aBytes: result.m4a.byteLength,
      m4aMb: Math.round(result.m4a.byteLength / 1024 / 1024),
      duration: Math.round(result.duration),
    })

    if (signal?.aborted) return

    const m4aBlob = new Blob([result.m4a], { type: 'audio/mp4' })
    try {
      await putBookAudio({
        bookId: book.id,
        blob: m4aBlob,
        duration: result.duration,
        paragraphOffsets: result.paragraphOffsets,
        durations: result.durations,
        voiceId,
        createdAt: Date.now(),
      })
      console.log('[taletrek] upload: encode stored', { title: book.title })
    } catch (err) {
      if (isQuotaExceededError(err)) {
        console.warn('[taletrek] upload: encode quota hit, evicting + retrying', {
          title: book.title,
          errName: (err as Error).name,
          errCode: (err as DOMException).code,
          errMessage: (err as Error).message,
        })
        // Evict every non-pinned cache entry to make room, then retry once.
        await evictAudioCacheToBudget(0)
        try {
          await putBookAudio({
            bookId: book.id,
            blob: m4aBlob,
            duration: result.duration,
            paragraphOffsets: result.paragraphOffsets,
            durations: result.durations,
            voiceId,
            createdAt: Date.now(),
          })
          console.log('[taletrek] upload: encode stored after retry', { title: book.title })
        } catch (retryErr) {
          if (isQuotaExceededError(retryErr)) {
            console.log('[taletrek] upload: quota persists, skipping mobile encode for', book.title)
            return
          }
          throw retryErr
        }
      } else {
        throw err
      }
    }
  }
}

export const uploadManager = new UploadManager()
