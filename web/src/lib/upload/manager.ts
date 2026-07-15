import type { Book, BookId, Chapter, VoiceId } from '../../types'
import { concatClient } from '../audio/concat-client'
import { putBookAudio } from '../book-audio'
import { cleanChapters } from '../clean'
import type { CleaningConfig } from '../clean/types'
import { deleteBookCascade, getBook, putBook } from '../db'
import { type ParagraphPreSynthInfo, preSynthesizeBook } from '../pre-synth'
import { ttsClient } from '../tts/client'

export type JobState =
  | { type: 'idle' }
  | { type: 'voiceDownload'; book: Book; fraction: number }
  | {
      type: 'synthesizing'
      book: Book
      done: number
      total: number
      synthesizedParagraphIds: Set<string>
    }
  | { type: 'encoding'; book: Book; progress?: number }
  | { type: 'done'; book: Book }
  | { type: 'error'; book: Book; message: string }

export interface JobSpec {
  book: Book
  chapters: Chapter[]
  voiceId: VoiceId
  cleaning: CleaningConfig
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
    this.abortController = new AbortController()
    void this.runJob(spec)
  }

  cancel(): void {
    this.abortController?.abort()
  }

  dismiss(): void {
    if (this.state.type === 'done' || this.state.type === 'error') {
      this.setState({ type: 'idle' })
    }
  }

  _resetForTests(): void {
    this.abortController?.abort()
    this.abortController = null
    this.state = { type: 'idle' }
  }

  private setState(next: JobState): void {
    this.state = next
    for (const ln of this.listeners) ln()
  }

  private async runJob(spec: JobSpec): Promise<void> {
    const { book, chapters, voiceId, cleaning } = spec
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
          this.setState({ type: 'voiceDownload', book, fraction })
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
          })
        },
      })

      if (signal?.aborted) {
        this.setState({ type: 'idle' })
        return
      }

      if (isMobile && preSynthResult.paragraphs.length > 0) {
        await this.encodeBook(book, voiceId, preSynthResult.paragraphs, signal)
      }

      await clearUploadingFlag(book.id)
      this.setState({ type: 'done', book })
    } catch (error) {
      if (signal?.aborted) {
        this.setState({ type: 'idle' })
      } else {
        console.error('[taletrek] upload: failed for', book.title, error)
        await deleteBookCascade(book.id).catch(() => {})
        this.setState({
          type: 'error',
          book,
          message: error instanceof Error ? error.message : 'Upload failed',
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
    signal?: AbortSignal,
  ): Promise<void> {
    this.setState({ type: 'encoding', book })

    await concatClient.loadCore((fraction) => {
      if (signal?.aborted) return
      this.setState({ type: 'encoding', book, progress: fraction })
    })

    if (signal?.aborted) return

    this.setState({ type: 'encoding', book, progress: 1 })

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
