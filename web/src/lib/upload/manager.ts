import type { Book, BookId, Chapter, VoiceId } from '../../types'
import { concatClient } from '../audio/concat-client'
import { putBookAudio } from '../book-audio'
import { cleanChapters } from '../clean'
import type { CleaningConfig } from '../clean/types'
import { deleteBookCascade, getBook, putBook } from '../db'
import { type ParagraphPreSynthInfo, preSynthesizeBook } from '../pre-synth'
import { ttsClient } from '../tts/client'

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
  | { type: 'done'; book: Book; mode: JobMode }
  | { type: 'error'; book: Book; message: string; mode: JobMode }

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
      this.state.type === 'encoding'
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
    this.abortController?.abort()
  }

  dismiss(): void {
    if (this.state.type === 'done' || this.state.type === 'error') {
      this.setState({ type: 'idle' })
    }
  }

  /**
   * Re-run the last job spec. Only valid from a `resynth`-mode error — initial
   * errors cascade-delete the book, so there's nothing to retry. No-op
   * otherwise (e.g. while active, or when the last job succeeded).
   */
  retry(): void {
    if (this.state.type !== 'error' || this.state.mode !== 'resynth') return
    if (this.isActive() || !this.lastSpec) return
    this.startJob(this.lastSpec)
  }

  /** Whether a retry is available in the current state (for UI affordances). */
  canRetry(): boolean {
    return this.state.type === 'error' && this.state.mode === 'resynth' && this.lastSpec !== null
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

    this.setState({
      type: 'synthesizing',
      book,
      done: 0,
      total: refs.length,
      synthesizedParagraphIds: new Set(),
      mode,
    })

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
        await this.encodeBook(book, voiceId, preSynthResult.paragraphs, signal, mode)
      }

      await clearUploadingFlag(book.id)
      this.setState({ type: 'done', book, mode })
    } catch (error) {
      if (signal?.aborted) {
        this.setState({ type: 'idle' })
      } else {
        console.error('[taletrek] upload: failed for', book.title, error)
        // Initial uploads cascade-delete on failure (the book has no audio and
        // no user investment yet). Re-synths keep the book — the user's text is
        // intact and they may retry.
        if (mode === 'initial') {
          await deleteBookCascade(book.id).catch(() => {})
        }
        this.setState({
          type: 'error',
          book,
          message: error instanceof Error ? error.message : 'Upload failed',
          mode,
        })
      }
    } finally {
      this.abortController = null
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
    await putBookAudio({
      bookId: book.id,
      blob: m4aBlob,
      duration: result.duration,
      paragraphOffsets: result.paragraphOffsets,
      durations: result.durations,
      voiceId,
      createdAt: Date.now(),
    })
  }
}

export const uploadManager = new UploadManager()
