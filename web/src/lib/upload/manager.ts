import type { Book, Chapter, VoiceId } from '../../types'
import { cleanChapters } from '../clean'
import type { CleaningConfig } from '../clean/types'
import { preSynthesizeBook } from '../pre-synth'
import { ttsClient } from '../tts/client'

/**
 * State of the single background synthesis job. The manager owns at most one
 * job at a time — both upload pre-synth and per-book re-synth funnel through
 * the same slot (they share the lone TTS worker anyway).
 *
 * `synthesizedParagraphIds` uses positional ids (`${chapterId}:${index}`) over
 * the **cleaned** chapters, matching what `useParagraphPlayer` /
 * `ReaderView` derive. Phase 2 (streaming) consumes this set to render
 * per-paragraph "buffered" indicators and gate playback at the frontier.
 */
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
  | { type: 'done'; book: Book }
  | { type: 'error'; book: Book; message: string }

export interface JobSpec {
  book: Book
  /** Raw chapters — the manager cleans them with the snapshotted config. */
  chapters: Chapter[]
  voiceId: VoiceId
  cleaning: CleaningConfig
}

/** A non-empty paragraph reference, matching `preSynthesizeBook`'s flatten order. */
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
 * Module-level singleton owning the background synthesis job. Survives route
 * changes (unlike the old per-component `useBookUpload` hook whose state died
 * on unmount while the underlying `preSynthesizeBook` promise leaked). Exposed
 * to React via `useUploadState` (`useSyncExternalStore`) — upload progress is
 * too high-frequency for Context (AGENTS.md: Context is for settings/theme
 * only, never playback/upload).
 *
 * One job at a time: `startJob` throws if a job is active. Voice + cleaning
 * are snapshotted at start so a mid-job settings change can't drift the voice
 * paragraph-by-paragraph.
 */
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
    return this.state.type === 'voiceDownload' || this.state.type === 'synthesizing'
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

  /** Clear a terminal `done`/`error` back to `idle`. */
  dismiss(): void {
    if (this.state.type === 'done' || this.state.type === 'error') {
      this.setState({ type: 'idle' })
    }
  }

  /** Test-only: force back to idle and clear listeners. */
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

    // Set initial state synchronously so consumers see activity immediately
    // (and isActive() is true before the first synth resolves).
    this.setState({
      type: 'synthesizing',
      book,
      done: 0,
      total: refs.length,
      synthesizedParagraphIds: new Set(),
    })

    try {
      await preSynthesizeBook({
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
      } else {
        this.setState({ type: 'done', book })
      }
    } catch (error) {
      if (signal?.aborted) {
        this.setState({ type: 'idle' })
      } else {
        this.setState({
          type: 'error',
          book,
          message: error instanceof Error ? error.message : 'Synthesis failed',
        })
      }
    } finally {
      this.abortController = null
    }
  }
}

export const uploadManager = new UploadManager()
