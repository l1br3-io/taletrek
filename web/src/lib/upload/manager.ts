import type { Book, BookId, Chapter, VoiceId } from '../../types'
import { concatClient } from '../audio/concat-client'
import { putBookAudio } from '../book-audio'
import { cleanChapters } from '../clean'
import type { CleaningConfig } from '../clean/types'
import { deleteBookCascade, getBook, putBook } from '../db'
import {
  evictAudioCacheToBudget,
  isQuotaExceededError,
  setPinnedAudioCacheBookId,
} from '../db/audio-cache'
import type { ParagraphPreSynthInfo } from '../pre-synth'
import { preSynthesizeBook } from '../pre-synth'
import { ttsClient } from '../tts/client'
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
    }
  | { type: 'encoding'; book: Book; progress?: number; mode: JobMode }
  | { type: 'cancelling'; book: Book; mode: JobMode }
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

function isMobileDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
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

function isTransientStorageError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (isQuotaExceededError(error) ||
      error.name === 'NotReadableError' ||
      error.name === 'UnknownError')
  )
}

async function clearUploadingFlag(bookId: BookId): Promise<void> {
  const book = await getBook(bookId)
  if (book) {
    delete book.uploading
    book.updatedAt = Date.now()
    await putBook(book)
  }
}

class UploadManager {
  private state: JobState = { type: 'idle' }
  private readonly listeners = new Set<() => void>()
  private abortController: AbortController | null = null
  private lastSpec: (JobSpec & { mode: JobMode }) | null = null

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
    // Flip to `cancelling` immediately so the UI can reflect the request
    // before the in-flight async work observes the abort and resolves.
    this.setState({ type: 'cancelling', book, mode })
    this.abortController.abort()
  }

  dismiss(): void {
    if (this.state.type === 'done' || this.state.type === 'error') {
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
    this.state = { type: 'idle' }
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
    this.setState({
      type: 'synthesizing',
      book,
      done: 0,
      total: refs.length,
      synthesizedParagraphIds: new Set(),
      mode,
    })

    // Hold a screen wake lock for the full job (synth + mobile encode) so the
    // auto-lock timer doesn't freeze the workers mid-render. Best-effort.
    const wakeLock = await acquireUploadWakeLock()

    try {
      const preSynthResult = await preSynthesizeBook({
        bookId: book.id,
        chapters: cleaned,
        voiceId,
        engine: ttsClient,
        signal,
        onVoiceDownload: (fraction) => {
          if (signal?.aborted) return
          this.setState({ type: 'voiceDownload', book, fraction, mode })
        },
        onProgress: (done, total) => {
          if (signal?.aborted) return
          const synthesizedParagraphIds = new Set(refs.slice(0, done).map((r) => r.id))
          this.setState({
            type: 'synthesizing',
            book,
            done,
            total,
            synthesizedParagraphIds,
            mode,
          })
        },
      })

      if (signal?.aborted) {
        this.setState({ type: 'idle' })
        return
      }

      if (isMobile && preSynthResult.paragraphs.length > 0) {
        const estimatedM4aBytes = Math.ceil(
          preSynthResult.paragraphs.reduce(
            (sum, p) => sum + p.durationSeconds * MOBILE_AAC_BYTES_PER_SECOND,
            0,
          ),
        )
        if (estimatedM4aBytes <= MAX_MOBILE_M4A_BYTES) {
          await this.encodeBook(book, voiceId, preSynthResult.paragraphs, signal, mode)
        } else {
          console.log(
            '[taletrek] upload: mobile encode skipped for huge book',
            book.title,
            `${Math.round(estimatedM4aBytes / 1024 / 1024)} MB estimated`,
          )
        }
      }

      await clearUploadingFlag(book.id)
      this.setState({ type: 'done', book, mode })
    } catch (error) {
      if (signal?.aborted) {
        this.setState({ type: 'idle' })
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
        console.error('[taletrek] upload: failed', errorInfo, error)

        const transient = isTransientStorageError(error)
        if (mode === 'initial' && !transient) {
          // Hard failure during fresh upload — nothing to preserve.
          await deleteBookCascade(book.id).catch(() => {})
        } else if (mode === 'initial' && transient) {
          // Storage-pressure failure: keep the book and offer a retry. Clear
          // the uploading flag so the boot sweep does not delete it.
          await clearUploadingFlag(book.id).catch(() => {})
        }
        // Resynth mode always keeps the book intact.

        this.setState({
          type: 'error',
          book,
          message: error instanceof Error ? error.message : 'Upload failed',
          mode,
          retryable: mode === 'resynth' || transient,
        })
      }
    } finally {
      setPinnedAudioCacheBookId(null)
      await wakeLock.release()
      this.abortController = null
      // If the user cancelled but an async path didn't observe the abort
      // (e.g. the encoding phase has unconditional setState calls that may
      // have run after abort), make sure we don't strand the UI in
      // `cancelling` forever — force it back to idle.
      if (this.state.type === 'cancelling') {
        this.setState({ type: 'idle' })
      }
    }
  }

  private async encodeBook(
    book: Book,
    voiceId: VoiceId,
    paragraphs: ParagraphPreSynthInfo[],
    signal: AbortSignal | undefined,
    mode: JobMode,
  ): Promise<void> {
    this.setState({ type: 'encoding', book, mode })

    await concatClient.loadCore((fraction) => {
      if (signal?.aborted) return
      this.setState({ type: 'encoding', book, progress: fraction, mode })
    })

    if (signal?.aborted) return

    this.setState({ type: 'encoding', book, progress: 1, mode })

    const keys = paragraphs.map((p) => p.cacheKey)
    const result = await concatClient.concat(keys)

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
    } catch (err) {
      if (isQuotaExceededError(err)) {
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
