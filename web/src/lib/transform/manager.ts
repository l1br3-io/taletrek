/**
 * Singleton manager for whole-book AI streaming transforms (M13 / ADR-0012).
 *
 * Drives an op × chapter × chunk loop over a book's chapters, streaming each
 * chunk's tokens to subscribers via {@link BookTransformState}. State is
 * external-store compatible (`subscribe` + `getState`) so React hooks
 * (`useBookTransformState`) can subscribe via `useSyncExternalStore`.
 *
 * Mirrors `uploadManager`'s singleton pattern. Resume contract mirrors
 * ADR-0009 / gotcha #18 / gotcha #24:
 *   - Persisted on the book record as `transformJob` + `transforming` flag.
 *   - **Load-bearing:** a paused transform has `transforming = false`. The
 *     boot sweep only acts on `transforming === true` (truly interrupted).
 *   - Resume is **user-initiated** from the library badge or reader banner.
 *     No auto-resume on boot.
 *   - **Never cascade-delete.** Cancel keeps already-committed paragraphs.
 *
 * Resume granularity is **chapter-level** (the unit at which `engine.transform`
 * commits and `putChapters` writes). If a chapter has multiple chunks and the
 * job aborts mid-chunk, that chapter restarts from chunk 0 on resume — the
 * M8 audio cache is content-addressed, so any cached paragraphs fast-forward
 * for free.
 */

import type { Book, BookId, Chapter, PersistedTransformJob, VoiceId } from '../../types'
import { getAiEngineForDef } from '../ai/client'
import { isReductive as engineIsReductive } from '../ai/runner'
import { splitOutput } from '../ai/prompts'
import type { AiSettings, ChunkStreamInfo, TransformDefinition, TransformOp } from '../ai/types'
import { deleteBookAudio } from '../book-audio'
import type { CleaningConfig } from '../clean/types'
import {
  deleteAudioCacheKeys,
  getAudioCacheKeysByBook,
  getBook,
  getChaptersByBook,
  putBook,
  putChapters,
  updateBookProcessing,
  updateBookProgress,
} from '../db'
import { uploadManager } from '../upload/manager'
import type { WakeLockHandle } from '../wake-lock'
import { acquireUploadWakeLock } from '../wake-lock'

// Re-export so callers can import from the manager.
export type { PersistedTransformJob }

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type BookTransformState =
  | { type: 'idle' }
  | {
      type: 'running'
      bookId: BookId
      opLabel: string
      currentOpIndex: number
      totalOps: number
      currentChapterIndex: number
      totalChapters: number
      /** Chapters completed across all ops (for progress bar). */
      done: number
      /** Total chapter-units across all ops. */
      total: number
      /**
       * `performance.now()` timestamp captured when the current chapter's
       * `engine.transform` call began. Used by the banner's elapsed timer
       * during the pre-token "preparing" phase (provider latency can be
       * minutes on slow / free-tier models — without an elapsed counter
       * the user assumes the app is hung).
       */
      chapterStartedAt: number
      /**
       * Live in-place streaming paragraphs for the active chapter. When
       * present, the reader replaces the chapter's paragraph slots with
       * these (last = in-progress, with cursor). Null between chunks and
       * after chunk completion (paragraphs commit to IDB then).
       *
       * Two render modes:
       * - `isReductive === false` (cleanup/simplify/etc.): slot-preserving —
       *   paragraphs map 1:1 to `chapter.paragraphs` slots starting at
       *   `chunkStartIndex`. Unstreamed slots render old text dimmed.
       * - `isReductive === true` (summarize): wholesale replace — old
       *   paragraphs disappear, new ones grow in one-by-one.
       */
      streamingParagraphs: {
        chunkIndex: number
        chunkTotal: number
        opLabel: string
        isReductive: boolean
        chunkStartIndex: number
        chunkInputCount: number
        paragraphs: string[]
        /**
         * Live reasoning/thinking text from reasoning models (glm-5.2,
         * DeepSeek-R1, etc.). Empty for non-reasoning models. Surfaced in
         * the preparing chip so the user sees the model is "thinking" rather
         * than staring at an opaque wait — critical for slow reasoning
         * models where the pre-token gap can be tens of seconds.
         */
        reasoning: string
      } | null
    }
  | {
      type: 'paused'
      bookId: BookId
      done: number
      total: number
      currentOpIndex: number
    }
  | { type: 'done'; bookId: BookId }
  | { type: 'error'; bookId: BookId; message: string }

// ---------------------------------------------------------------------------
// Per-book write serialization (mirrors uploadManager's pattern)
// ---------------------------------------------------------------------------

const bookWriteQueue = new Map<BookId, Promise<void>>()

function enqueueBookWrite(bookId: BookId, fn: () => Promise<void>): Promise<void> {
  const prev = bookWriteQueue.get(bookId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const cleanup = () => {
    if (bookWriteQueue.get(bookId) === next) bookWriteQueue.delete(bookId)
  }
  next.then(cleanup, cleanup)
  bookWriteQueue.set(bookId, next)
  return next
}

async function setTransformJob(
  bookId: BookId,
  job: PersistedTransformJob,
  opts: { transforming?: boolean } = {},
): Promise<void> {
  return enqueueBookWrite(bookId, async () => {
    const book = await getBook(bookId)
    if (!book) return
    book.transformJob = job
    if (opts.transforming !== undefined) book.transforming = opts.transforming
    book.updatedAt = Date.now()
    await putBook(book)
  })
}

async function patchTransformJob(
  bookId: BookId,
  patch: Partial<PersistedTransformJob>,
  opts: { transforming?: boolean; clearTransforming?: boolean; clearJob?: boolean } = {},
): Promise<void> {
  return enqueueBookWrite(bookId, async () => {
    const book = await getBook(bookId)
    if (!book) return
    if (opts.clearJob) {
      delete book.transformJob
    } else if (book.transformJob) {
      book.transformJob = { ...book.transformJob, ...patch }
    }
    if (opts.transforming !== undefined) book.transforming = opts.transforming
    if (opts.clearTransforming) delete book.transforming
    book.updatedAt = Date.now()
    await putBook(book)
  })
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface TransformJobSpec {
  book: Book
  chapters: Chapter[]
  ops: TransformOp[]
  voiceId: VoiceId
  cleaning: CleaningConfig
}

interface RunContext {
  spec: TransformJobSpec
  ai: AiSettings
  defs: TransformDefinition[]
  synthEnabled: boolean
  /** Start indices for resume — default 0/0. */
  startOpIndex: number
  startChapterIndex: number
  /** Counts completed before this run started (for resume progress continuity). */
  doneOffset: number
}

class BookTransformManager {
  private state: BookTransformState = { type: 'idle' }
  private readonly listeners = new Set<() => void>()
  private abortController: AbortController | null = null
  private pauseRequested = false
  private wakeLock: WakeLockHandle | null = null
  private currentContext: RunContext | null = null

  /**
   * Stream-emit throttle state. We use a one-shot `setTimeout(…, 250ms)`
   * rather than `requestAnimationFrame`: rAF throttles to ~1Hz or stalls
   * entirely when the tab is hidden (gotcha #23 — same reason the Web Audio
   * scheduler uses setInterval), which would freeze the live token stream
   * any time the user switches tabs during a transform. setInterval at 250ms
   * caps us at ~4 emits/sec — plenty for readable token-by-token rendering
   * and kind to React. The latest parsed paragraphs win; intermediate tokens
   * collapse into the next tick.
   */
  private streamEmitHandle: ReturnType<typeof setTimeout> | null = null
  private pendingStreamParagraphs: string[] | null = null
  private pendingStreamReasoning: string | null = null
  private pendingStreamChunkInfo: {
    chunkIndex: number
    chunkTotal: number
    opLabel: string
    isReductive: boolean
    chunkStartIndex: number
    chunkInputCount: number
  } | null = null

  /** Coalesce cadence for streamingParagraphs emits (ms). */
  private static readonly STREAM_EMIT_INTERVAL_MS = 250

  getState = (): BookTransformState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  private scheduleStreamEmit(
    paragraphs: string[],
    reasoning: string,
    chunkInfo: {
      chunkIndex: number
      chunkTotal: number
      opLabel: string
      isReductive: boolean
      chunkStartIndex: number
      chunkInputCount: number
    },
  ): void {
    this.pendingStreamParagraphs = paragraphs
    this.pendingStreamReasoning = reasoning
    this.pendingStreamChunkInfo = chunkInfo
    if (this.streamEmitHandle !== null) return
    this.streamEmitHandle = setTimeout(() => {
      this.streamEmitHandle = null
      const paragraphs = this.pendingStreamParagraphs
      const reasoning = this.pendingStreamReasoning
      const info = this.pendingStreamChunkInfo
      this.pendingStreamParagraphs = null
      this.pendingStreamReasoning = null
      this.pendingStreamChunkInfo = null
      if (paragraphs === null || info === null) return
      if (this.state.type !== 'running') return
      this.state = {
        ...this.state,
        streamingParagraphs: {
          chunkIndex: info.chunkIndex,
          chunkTotal: info.chunkTotal,
          opLabel: info.opLabel,
          isReductive: info.isReductive,
          chunkStartIndex: info.chunkStartIndex,
          chunkInputCount: info.chunkInputCount,
          paragraphs,
          reasoning: reasoning ?? '',
        },
      }
      this.emit()
    }, BookTransformManager.STREAM_EMIT_INTERVAL_MS)
  }

  /** Flush any pending stream emit immediately (used at chunk boundaries + pause). */
  private flushStreamEmit(): void {
    if (this.streamEmitHandle !== null) {
      clearTimeout(this.streamEmitHandle)
      this.streamEmitHandle = null
    }
    if (this.pendingStreamParagraphs !== null && this.pendingStreamChunkInfo !== null) {
      if (this.state.type === 'running') {
        this.state = {
          ...this.state,
          streamingParagraphs: {
            chunkIndex: this.pendingStreamChunkInfo.chunkIndex,
            chunkTotal: this.pendingStreamChunkInfo.chunkTotal,
            opLabel: this.pendingStreamChunkInfo.opLabel,
            isReductive: this.pendingStreamChunkInfo.isReductive,
            chunkStartIndex: this.pendingStreamChunkInfo.chunkStartIndex,
            chunkInputCount: this.pendingStreamChunkInfo.chunkInputCount,
            paragraphs: this.pendingStreamParagraphs,
            reasoning: this.pendingStreamReasoning ?? '',
          },
        }
      }
      this.pendingStreamParagraphs = null
      this.pendingStreamReasoning = null
      this.pendingStreamChunkInfo = null
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async start(
    spec: TransformJobSpec,
    deps: { ai: AiSettings; defs: TransformDefinition[]; synthEnabled: boolean },
  ): Promise<void> {
    console.log('[taletrek] transform: start() called', {
      bookId: spec.book.id,
      title: spec.book.title,
      opsCount: spec.ops.length,
      chaptersCount: spec.chapters.length,
      aiEnabled: deps.ai.enabled,
      currentState: this.state.type,
    })
    // Pre-loop validations surface as `state.error` (not synchronous throws)
    // so the reader — which subscribes via useBookTransformState — renders
    // the cause in the GenerationBanner. A bare `throw` here would be caught
    // by `onRunGenerate`'s try/catch and silently swallowed, leaving the
    // user staring at a reader with no banner and no idea what failed
    // (M13 regression found 2026-07-20).
    const failSync = (message: string): void => {
      console.warn('[taletrek] transform: start() failing synchronously:', message)
      this.state = { type: 'error', bookId: spec.book.id, message }
      this.emit()
    }

    if (this.state.type === 'running' || this.state.type === 'paused') {
      // If a paused job exists for THIS book, treat the click as a Resume
      // intent — kick the existing paused state instead of erroring. The
      // common case is: user paused, clicked Generate again from the modal,
      // and expects their new spec to run. Cancel the paused job (preserving
      // its already-committed paragraphs) then start fresh.
      if (
        this.state.type === 'paused' &&
        'bookId' in this.state &&
        this.state.bookId === spec.book.id
      ) {
        await patchTransformJob(spec.book.id, {}, { clearJob: true, clearTransforming: true })
        this.state = { type: 'idle' }
        this.emit()
      } else {
        failSync(
          this.state.type === 'paused'
            ? `A paused transform exists for another book. Resume or cancel it first.`
            : 'A book transform is already in progress.',
        )
        return
      }
    }
    if (spec.ops.length === 0) {
      failSync('No transform ops selected.')
      return
    }
    if (!deps.ai.enabled) {
      failSync('AI is not enabled — open Settings → AI.')
      return
    }

    const book = await getBook(spec.book.id)
    if (!book) {
      failSync('Book not found.')
      return
    }
    if (book.uploading) {
      // `uploading: true` is set by `ingestBook` at upload time and only
      // cleared by the upload manager's synth path. When the user takes the
      // AI-transform branch from the post-upload modal, `proceedWithBook` is
      // never called, so no synth job ever runs — but the flag stays `true`
      // forever, falsely blocking Generate (regression found 2026-07-20).
      //
      // Resolution: if `uploadManager.isActive()` is true, a real synth is
      // running and we genuinely can't proceed (let the user wait/cancel it).
      // Otherwise the flag is stale — clear it and continue.
      if (uploadManager.isActive()) {
        failSync('Synthesis is in progress on this book — wait for it to finish first.')
        return
      }
      delete book.uploading
      book.updatedAt = Date.now()
      await putBook(book)
    }

    this.pauseRequested = false
    this.abortController = new AbortController()
    this.currentContext = {
      spec,
      ai: deps.ai,
      defs: deps.defs,
      synthEnabled: deps.synthEnabled,
      startOpIndex: 0,
      startChapterIndex: 0,
      doneOffset: 0,
    }
    await this.runLoop()
  }

  pause(): void {
    if (this.state.type !== 'running') return
    this.pauseRequested = true
    this.abortController?.abort()
  }

  async resume(
    bookId: BookId,
    deps: { ai: AiSettings; defs: TransformDefinition[]; synthEnabled: boolean },
  ): Promise<void> {
    if (this.state.type === 'running' || this.state.type === 'paused') {
      throw new Error('A book transform is already in progress.')
    }
    const book = await getBook(bookId)
    if (!book?.transformJob) throw new Error('No paused transform job for this book.')
    if (book.uploading) {
      throw new Error('Synthesis is in progress on this book — wait for it to finish first.')
    }
    const chapters = await getChaptersByBook(bookId)
    if (chapters.length === 0) throw new Error('Chapters not found — cannot resume.')

    const job = book.transformJob
    this.pauseRequested = false
    this.abortController = new AbortController()
    this.currentContext = {
      spec: {
        book,
        chapters,
        ops: job.ops,
        voiceId: job.voiceId,
        cleaning: job.cleaning,
      },
      ai: deps.ai,
      defs: deps.defs,
      synthEnabled: deps.synthEnabled,
      startOpIndex: job.currentOpIndex,
      startChapterIndex: job.currentChapterIndex,
      doneOffset: job.done,
    }
    await this.runLoop()
  }

  /**
   * Test-only: synchronously force the manager to idle, abort any in-flight
   * controller, cancel pending rAF, release wake lock. Does NOT clear IDB —
   * tests manage their own DB state via `_clearDBForTests`. Mirrors the
   * `_resetDBForTests` pattern in `db/connection.ts`.
   */
  _resetForTests(): void {
    this.pauseRequested = false
    this.cancelIntent = false
    this.abortController?.abort()
    this.abortController = null
    if (this.streamEmitHandle !== null) {
      clearTimeout(this.streamEmitHandle)
      this.streamEmitHandle = null
    }
    this.pendingStreamParagraphs = null
    this.pendingStreamReasoning = null
    this.pendingStreamChunkInfo = null
    this.wakeLock?.release()
    this.wakeLock = null
    this.currentContext = null
    this.state = { type: 'idle' }
    this.emit()
  }

  async cancel(): Promise<void> {
    if (this.state.type !== 'running' && this.state.type !== 'paused') return
    // If running, abort the loop first — its finally block will handle cleanup.
    if (this.state.type === 'running') {
      this.pauseRequested = false
      this.abortController?.abort()
      // Wait briefly for the loop to settle. The loop's catch sees AbortError
      // and would normally convert to paused; we set a cancelIntent flag to
      // tell it to go to idle instead.
      this.cancelIntent = true
      // The runLoop's finally will clear the persisted job.
    } else {
      // Paused — clear persisted state directly.
      const bookId = this.state.bookId
      await patchTransformJob(bookId, {}, { clearJob: true, clearTransforming: true })
      this.state = { type: 'idle' }
      this.emit()
    }
  }

  private cancelIntent = false

  async retry(
    bookId: BookId,
    deps: { ai: AiSettings; defs: TransformDefinition[]; synthEnabled: boolean },
  ): Promise<void> {
    const book = await getBook(bookId)
    if (!book?.transformJob) throw new Error('No transform job to retry.')
    await this.resume(bookId, deps)
  }

  // -------------------------------------------------------------------------
  // Run loop
  // -------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    const ctx = this.currentContext
    if (!ctx) return
    const { spec, ai, defs, synthEnabled, startOpIndex, startChapterIndex, doneOffset } = ctx

    // Defensive reset
    this.cancelIntent = false

    // Resolve all defs upfront
    const opDefPairs: Array<{ op: TransformOp; def: TransformDefinition }> = []
    for (const op of spec.ops) {
      const def = defs.find((d) => d.id === op.defId)
      if (!def) {
        this.state = {
          type: 'error',
          bookId: spec.book.id,
          message: `Transform "${op.defId}" not found — it may have been deleted.`,
        }
        this.emit()
        this.currentContext = null
        return
      }
      const engine = getAiEngineForDef(ai, def)
      if (!engine) {
        this.state = {
          type: 'error',
          bookId: spec.book.id,
          message: `No provider configured for "${def.label}". Open Settings → AI and configure a provider.`,
        }
        this.emit()
        this.currentContext = null
        return
      }
      opDefPairs.push({ op, def })
    }

    const totalChaptersPerOp = spec.chapters.length
    const total = spec.ops.length * totalChaptersPerOp

    // Set running state + persist transforming flag from the very first tick
    // (mirrors gotcha #18's "write from first tick" rule).
    this.state = {
      type: 'running',
      bookId: spec.book.id,
      opLabel: opDefPairs[startOpIndex]?.def.label ?? '',
      currentOpIndex: startOpIndex,
      totalOps: spec.ops.length,
      currentChapterIndex: startChapterIndex,
      totalChapters: totalChaptersPerOp,
      done: doneOffset,
      total,
      chapterStartedAt: performance.now(),
      streamingParagraphs: null,
    }
    this.emit()
    await setTransformJob(
      spec.book.id,
      {
        ops: spec.ops,
        voiceId: spec.voiceId,
        cleaning: spec.cleaning,
        currentOpIndex: startOpIndex,
        currentChapterIndex: startChapterIndex,
        done: doneOffset,
        total,
        pausedAt: Date.now(),
      },
      { transforming: true },
    )

    // Acquire wake lock (best-effort, never fatal — ADR-0009).
    this.wakeLock = await acquireUploadWakeLock()

    // Working copy of chapters — each op's output feeds the next op.
    let working: Chapter[] = spec.chapters
    let done = doneOffset

    try {
      for (let i = startOpIndex; i < opDefPairs.length; i++) {
        const { op, def } = opDefPairs[i]!
        const engine = getAiEngineForDef(ai, def)!
        const reductive = engineIsReductive(def)
        const startC = i === startOpIndex ? startChapterIndex : 0

        for (let c = startC; c < working.length; c++) {
          if (this.abortController?.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError')
          }
          const chapter = working[c]!
          const chapterStartTime = performance.now()
          // Use console.log (not console.info) — info is hidden by some
          // DevTools default verbosity filters, which made this regression
          // much harder to diagnose than it should have been.
          console.log(
            `[taletrek] transform: chapter ${c + 1}/${working.length} (op ${i + 1}/${opDefPairs.length}) — ${chapter.paragraphs.length} paragraphs`,
            {
              title: chapter.title,
              opLabel: def.label,
            },
          )
          // Update state: now transforming chapter c of op i.
          this.flushStreamEmit()
          this.state = {
            ...this.state,
            type: 'running',
            opLabel: def.label,
            currentOpIndex: i,
            currentChapterIndex: c,
            chapterStartedAt: performance.now(),
            streamingParagraphs: null,
          }
          this.emit()

          let chunkCount = 0
          let firstTokenAt: number | null = null
          let lastProgressLog = 0
          const progressLogInterval = 5000 // ms — periodic throughput log
          const onChunkStreamed = (info: ChunkStreamInfo) => {
            if (!info.isFinal) {
              chunkCount++
              const now = performance.now()
              if (firstTokenAt === null) {
                firstTokenAt = now
                console.log(
                  `[taletrek] transform: first token after ${Math.round(firstTokenAt - chapterStartTime!)}ms`,
                )
                lastProgressLog = now
              }
              // Periodic progress log so a slow stream doesn't look silent
              // in DevTools. Logs every 5s with cumulative stats.
              if (now - lastProgressLog >= progressLogInterval) {
                const elapsedSec = Math.max(1, Math.round((now - firstTokenAt) / 1000))
                const charsPerSec = Math.round(info.textSoFar.length / elapsedSec)
                console.log(
                  `[taletrek] transform: streaming… ${info.textSoFar.length} chars in ${elapsedSec}s (~${charsPerSec} c/s, ${chunkCount} events)`,
                )
                lastProgressLog = now
              }
              // Parse the cumulative streamed text into paragraphs via the
              // same splitter the runner uses at chunk completion. The last
              // element is the in-progress paragraph (no trailing \n\n yet).
              // This gives the reader true in-place rendering: each fully-
              // streamed paragraph snaps into its slot, the last grows
              // token-by-token with a blinking cursor.
              const paragraphs = splitOutput(info.textSoFar)
              this.scheduleStreamEmit(paragraphs, info.reasoningSoFar, {
                chunkIndex: info.chunkIndex,
                chunkTotal: info.chunkTotal,
                opLabel: def.label,
                isReductive: reductive,
                chunkStartIndex: info.chunkStartInputIndex,
                chunkInputCount: info.chunkInputCount,
              })
            } else {
              this.flushStreamEmit()
              // Clear streaming paragraphs on chunk completion — the chapter
              // commit below will replace IDB and the reader will re-fetch.
              // Between chunks in a multi-chunk chapter, briefly null so
              // the reader shows committed state before chunk N+1 starts.
              if (this.state.type === 'running') {
                this.state = {
                  ...this.state,
                  streamingParagraphs:
                    info.chunkIndex + 1 < info.chunkTotal
                      ? {
                          chunkIndex: info.chunkIndex + 1,
                          chunkTotal: info.chunkTotal,
                          opLabel: def.label,
                          isReductive: reductive,
                          chunkStartIndex: info.chunkStartInputIndex + info.chunkInputCount,
                          chunkInputCount: 0,
                          paragraphs: [],
                          reasoning: '',
                        }
                      : null,
                }
                this.emit()
              }
            }
          }

          console.log(`[taletrek] transform: engine.transform start — calling provider`)
          const out = await engine.transform(
            chapter.paragraphs,
            op,
            def,
            undefined,
            this.abortController?.signal,
            undefined,
            onChunkStreamed,
          )
          console.log(
            `[taletrek] transform: chapter ${c + 1} complete in ${Math.round(performance.now() - chapterStartTime)}ms — ${out.length} output paragraphs (${chunkCount} chunks)`,
          )

          // Commit the chapter. Defensive-clear headings on reductive ops so
          // legacy pre-M10 books don't end up with stale paragraphIndex values.
          const nextChapter: Chapter = reductive
            ? { ...chapter, paragraphs: out, headings: undefined }
            : { ...chapter, paragraphs: out }
          working = working.map((ch, idx) => (idx === c ? nextChapter : ch))

          // Persist chapters + bump job progress after each chapter.
          await putChapters(working)
          done += 1
          await patchTransformJob(
            spec.book.id,
            {
              currentOpIndex: i,
              currentChapterIndex: c + 1,
              done,
            },
            { transforming: true },
          )

          this.flushStreamEmit()
          this.state = {
            ...this.state,
            type: 'running',
            done,
            chapterStartedAt: performance.now(),
            streamingParagraphs: null,
          }
          this.emit()
        }
      }

      // Loop completed — write final state, clear job, kick resynth.
      const processing = { appliedAt: Date.now(), ops: spec.ops }
      await updateBookProcessing(spec.book.id, processing)
      const chapterIndex = spec.book.position?.chapterIndex ?? 0
      await updateBookProgress(spec.book.id, { chapterIndex, paragraphIndex: 0 }, 0)
      await patchTransformJob(spec.book.id, {}, { clearJob: true, clearTransforming: true })

      this.state = { type: 'done', bookId: spec.book.id }
      this.emit()

      // Sequential TTS resynth (decision 4 in ADR-0012).
      if (synthEnabled) {
        // Pass the deps explicitly — `this.currentContext` is cleared in the
        // finally block below before this fire-and-forget's microtask runs.
        void this.triggerResynth(spec.book, working, spec.voiceId, spec.cleaning)
      }
    } catch (e) {
      if (this.cancelIntent) {
        // Cancel: clear persisted job, go to idle. Keep already-committed chapters.
        await patchTransformJob(spec.book.id, {}, { clearJob: true, clearTransforming: true })
        this.state = { type: 'idle' }
        this.emit()
      } else if ((e as DOMException)?.name === 'AbortError' && this.pauseRequested) {
        // Explicit pause — set transforming=false (gotcha #24). Don't overwrite
        // currentOpIndex/currentChapterIndex: the inner-loop patchTransformJob
        // already wrote the correct "next chapter to resume from" value.
        await patchTransformJob(spec.book.id, { done }, { transforming: false })
        this.state = {
          type: 'paused',
          bookId: spec.book.id,
          done,
          total,
          currentOpIndex: this.state.type === 'running' ? this.state.currentOpIndex : 0,
        }
        this.emit()
      } else {
        // Genuine error (LLM failure, etc.) — keep the spec for retry, surface error.
        this.state = {
          type: 'error',
          bookId: spec.book.id,
          message: (e as Error)?.message || 'Transform failed.',
        }
        this.emit()
      }
    } finally {
      this.wakeLock?.release()
      this.wakeLock = null
      this.abortController = null
      this.pauseRequested = false
      this.cancelIntent = false
      this.currentContext = null
      this.flushStreamEmit()
    }
  }

  /**
   * Best-effort sequential TTS resynth after a transform completes. Purges
   * stale audio-cache keys (content-addressed, so un-transformed books keep
   * their entries) then kicks uploadManager in 'resynth' mode. Mirrors
   * `useAiTransform.ts:205-217`.
   *
   * Voice/cleaning passed explicitly (not read from `currentContext`) because
   * the finally block of `runLoop` clears `currentContext` before this
   * fire-and-forget's first microtask runs.
   */
  private async triggerResynth(
    book: Book,
    chapters: Chapter[],
    voiceId: VoiceId,
    cleaning: CleaningConfig,
  ): Promise<void> {
    try {
      const keys = await getAudioCacheKeysByBook(book.id)
      if (keys.length > 0) await deleteAudioCacheKeys(keys)
      await deleteBookAudio(book.id)
      const latest = { ...book, updatedAt: Date.now() }
      uploadManager.startJob({
        book: latest,
        chapters,
        voiceId,
        cleaning,
        mode: 'resynth',
      })
    } catch {
      // Silent — the banner is the primary error surface.
    }
  }
}

export const bookTransformManager = new BookTransformManager()
