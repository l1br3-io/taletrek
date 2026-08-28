/**
 * Server implementation of the datasource seam (ADR-0014, Effort 5 · T13+T14):
 * the SPA hosted by the personal server, talking same-origin HTTP with
 * implicit cookie auth (set by the `/ui/login` gate).
 *
 * Library surface (T13): books list/get (BookDto → SPA `Book`, position from
 * T11), chapters (T9 wire shape → SPA `Chapter`), progress PATCH (T11),
 * delete, and audio-presence probing. Thrown as "not available in hosted
 * mode" stubs: local-only library surfaces whose hosted equivalents are later
 * tasks (paragraph edits, original file access, backup).
 *
 * Pipeline (T14): upload parses in the browser workers (ADR-0013), serializes
 * the parsed book to an in-memory text-only bundle (`lib/bundle/writer` —
 * writing text-only is small; G27's whole-archive-in-memory concern applies
 * to *reading* full bundles, not this), POSTs it to `/api/books`, triggers
 * server-side synth, and polls `GET /api/jobs/:id` into the same `JobState`
 * shapes the local pipeline produces.
 *
 * # Job ownership — cancel only stops watching
 *
 * Synthesis runs **server-side**; `cancel()` stops the client's poll loop and
 * returns the UI to idle but the job keeps running on the server. Closing the
 * tab mid-job is the same case — reopen (or reload) and the boot recovery
 * (`recoverInFlightJobs`, wired in `main.tsx`) re-adopts the in-flight job
 * from `GET /api/jobs` so progress display resumes. The server's one-job-
 * per-book guard is authoritative: `POST …/synth` answering 409 triggers
 * adoption of the running job rather than an error.
 *
 * # Audio probing strategy (decided in T13)
 *
 * `getCachedParagraphIds` answers "which paragraphs have audio for voice V".
 * The server synthesizes a whole book in one job and rewrites its bundle on
 * completion, so a single `GET /api/books/{id}` suffices — no per-key HEAD
 * requests, no new manifest endpoint: audio exists for **every non-empty
 * paragraph** iff `audioPresent === true && voiceId === V` (blank paragraphs
 * are never synthesized, matching the local key derivation which skips
 * empty text). Mid-synth the bundle is not yet rewritten, so the probe
 * reports nothing until the job completes; the processing display (T14)
 * covers that window.
 *
 * # progressFraction piggybacks on `position`
 *
 * `PATCH /api/books/{id}/progress` stores its JSON body verbatim in
 * `books.position` — extra fields pass through by design (T11) — so the SPA's
 * `progressFraction` rides along as an extra field and is picked back out on
 * read. No server schema change.
 *
 * # 401 mid-session
 *
 * The cookie can expire under a mounted app; every op then rejects with
 * `ServerApiError` where `isUnauthorized` is true. Callers surface re-login
 * (T16 wires the redirect); nothing retries or caches here.
 */

import type {
  Book,
  BookFile,
  BookFormat,
  BookId,
  BookPosition,
  Chapter,
  VoiceId,
} from '../../types'
import { bookId, chapterId, newBookId } from '../../types'
import { getAiEngineForDef } from '../ai/client'
import type { ImportReport } from '../backup'
import type { BookAudio } from '../book-audio'
import type { BookBundle } from '../bundle/manifest'
import {
  chapterToChapterText,
  MANIFEST_SCHEMA_VERSION,
  SPA_GENERATOR_APP,
  WRITABLE_AUDIO_CODEC,
} from '../bundle/manifest'
import { writeBookBundle } from '../bundle/writer'
import { cleanChapters } from '../clean'
import type { CleaningConfig } from '../clean/types'
import { DEFAULT_CLEANING } from '../clean/types'
import { getSetting } from '../db'
import { type IngestResult, UnsupportedFileError } from '../ingest'
import { parseInWorker } from '../parse/client'
import { formatForFile } from '../parse/util'
import { NORM_VERSION } from '../tts/normalize'
import type { Voice } from '../tts/types'
import { DEFAULT_VOICE_ID } from '../tts/voices'
import type {
  BookTransformState,
  CancelForBookResult,
  JobSpec,
  JobState,
  LibraryDatasource,
  RecentJob,
  SynthPipeline,
  TransformJobSpec,
  TransformRunDeps,
} from './types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An HTTP-level failure talking to the personal server. */
export class ServerApiError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ServerApiError'
    this.status = status
  }

  /** 401 — the auth cookie expired mid-session; the user must re-login. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

/**
 * Mid-session 401 handling (T16): when a hosted operation rejects because
 * the auth cookie expired, send the browser to the no-JS login gate (the
 * same place the boot probe redirects). Returns whether it redirected, so
 * callers can skip their usual error surfacing.
 */
export function redirectToLoginIfUnauthorized(e: unknown): boolean {
  if (e instanceof ServerApiError && e.isUnauthorized) {
    window.location.assign('/ui/login')
    return true
  }
  return false
}

/** A UI-reachable operation with no hosted-mode implementation (yet). */
export class HostedModeUnavailableError extends Error {
  constructor(operation: string) {
    super(`${operation} is not available while hosted by the server.`)
    this.name = 'HostedModeUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (camelCase — mirror of the server's BookDto / ChapterDto)
// ---------------------------------------------------------------------------

/** Wire shape of a book as served by `GET /api/books[/{id}]`. */
export interface BookDto {
  id: string
  title: string
  author?: string | null
  sourceFormat: string
  voiceId: string
  audioPresent: boolean
  chapterCount: number
  createdAt: number
  updatedAt: number
  /** Verbatim PATCH progress body: `{ chapterIndex, paragraphIndex, …extras }`. */
  position?: Record<string, unknown> | null
}

/** Wire shape of a chapter as served by `GET /api/books/{id}/chapters`. */
export interface ChapterDto {
  /** Stable derived form `ch_<bookId>_<idx>` (T9). */
  id: string
  bookId: string
  idx: number
  title: string
  paragraphs: string[]
}

/**
 * Wire shape of a job as served by `GET /api/jobs[/{id}]` — the pipeline's
 * progress source (T14). `status`/`kind` serialize lowercase (JobStatus /
 * JobKind serde impls server-side).
 */
export interface JobDto {
  id: string
  bookId: string
  kind: 'synth' | 'resynth'
  voice: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  done: number
  total: number
  error: string | null
  createdAt: number
  updatedAt: number
}

const FORMATS: ReadonlySet<string> = new Set(['pdf', 'epub', 'mobi', 'txt', 'md'])

/** Coerce a wire `sourceFormat` to a SPA `BookFormat` (G28: unknown → txt). */
function toFormat(sourceFormat: string): BookFormat {
  return (FORMATS.has(sourceFormat) ? sourceFormat : 'txt') as BookFormat
}

/** Map a wire `BookDto` onto the SPA `Book` (position + fraction picked out
 * of the verbatim progress JSON; job-derived flags arrive with T14). */
function toBook(dto: BookDto): Book {
  const pos = dto.position
  const hasPosition =
    !!pos && typeof pos.chapterIndex === 'number' && typeof pos.paragraphIndex === 'number'
  const position: BookPosition | undefined = hasPosition
    ? {
        chapterIndex: pos.chapterIndex as number,
        paragraphIndex: pos.paragraphIndex as number,
      }
    : undefined
  const progressFraction =
    pos && typeof pos.progressFraction === 'number' ? pos.progressFraction : undefined
  return {
    id: bookId(dto.id),
    title: dto.title,
    format: toFormat(dto.sourceFormat),
    chapterCount: dto.chapterCount,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    ...(position !== undefined ? { position } : {}),
    ...(progressFraction !== undefined ? { progressFraction } : {}),
  }
}

function toChapter(dto: ChapterDto): Chapter {
  return {
    id: chapterId(dto.id),
    bookId: bookId(dto.bookId),
    index: dto.idx,
    title: dto.title,
    paragraphs: dto.paragraphs,
  }
}

// ---------------------------------------------------------------------------
// Fetch plumbing
// ---------------------------------------------------------------------------

/** Shared fetch plumbing for the server shape (also used by the T15 remote
 * playback engine): same-origin cookies, no-store, `ServerApiError` on any
 * HTTP/network failure. */
export async function api(
  fetchImpl: typeof fetch,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let res: Response
  try {
    res = await fetchImpl(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    })
  } catch (e) {
    throw new ServerApiError(e instanceof Error ? e.message : 'network error')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ServerApiError(body.trim() || `HTTP ${res.status}`, res.status)
  }
  return res
}

async function getJson<T>(fetchImpl: typeof fetch, path: string): Promise<T> {
  const res = await api(fetchImpl, path)
  return (await res.json()) as T
}

async function postJson<T>(fetchImpl: typeof fetch, path: string, body: unknown): Promise<T> {
  const res = await api(fetchImpl, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as T
}

/** `GET /api/books/{id}` → BookDto, or `undefined` on 404. */
async function fetchBookDto(fetchImpl: typeof fetch, id: BookId): Promise<BookDto | undefined> {
  try {
    return await getJson<BookDto>(fetchImpl, `/api/books/${encodeURIComponent(id)}`)
  } catch (e) {
    if (notFound(e)) return undefined
    throw e
  }
}

function notFound(e: unknown): boolean {
  return e instanceof ServerApiError && e.status === 404
}

/**
 * `GET /api/voices` → the server's curated catalog as the SPA `Voice`
 * shape (T16 hosted voice pickers — Settings + per-book synth). Settings
 * and voices stay client-side, so this lives beside the pipeline rather
 * than on the `LibraryDatasource` seam.
 */
export async function fetchServerVoices(fetchImpl: typeof fetch = fetch): Promise<Voice[]> {
  return getJson<Voice[]>(fetchImpl, '/api/voices')
}

/** Map a wire `JobDto` onto the seam's {@link RecentJob}. */
function toRecentJob(dto: JobDto): RecentJob {
  return {
    id: dto.id,
    bookId: bookId(dto.bookId),
    kind: dto.kind,
    status: dto.status,
    done: dto.done,
    total: dto.total,
    error: dto.error,
  }
}

/**
 * Read the user's cleaning config for egress (the hosted `ingestBook` bundle
 * write). Settings stay client-side IndexedDB in both modes (ADR-0014); the
 * SettingsProvider persists the merged object under `'app'` on every update
 * (same read pattern as `bundle/export.ts`'s voice recovery). A never-written
 * store (fresh install, first upload) falls back to the default config —
 * which matches what the reader displays before settings hydrate.
 */
async function readCleaningConfig(): Promise<CleaningConfig> {
  try {
    const stored = await getSetting<{ cleaning?: CleaningConfig }>('app')
    return stored?.cleaning ?? DEFAULT_CLEANING
  } catch {
    // IDB must never block an upload — fail open to the defaults.
    return DEFAULT_CLEANING
  }
}

/**
 * Build an in-memory **text-only** {@link BookBundle} for a book + chapters —
 * the hosted upload/transform-egress shape (T14). `writeBookBundle` derives
 * `audio.present`/`segmentCount` from the empty audio map and stamps the
 * generator, so the manifest's audio/generator fields here are placeholders
 * the writer overwrites. The stamped `book.voiceId` names the voice the
 * client intends to synth under; the server re-stamps it authoritatively on
 * job completion.
 */
function textOnlyBundle(
  book: Book,
  chapters: Chapter[],
  voice: VoiceId,
  meta: BookBundle['meta'] = {},
): BookBundle {
  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'book',
      book: {
        id: book.id,
        title: book.title,
        sourceFormat: book.format,
        chapterCount: chapters.length,
        voiceId: voice,
        createdAt: book.createdAt,
        updatedAt: Date.now(),
        ...(book.progressFraction !== undefined ? { progressFraction: book.progressFraction } : {}),
      },
      audio: {
        present: false,
        codec: WRITABLE_AUDIO_CODEC,
        normVersion: Number(NORM_VERSION),
        segmentCount: 0,
      },
      generator: { app: SPA_GENERATOR_APP, version: '' },
    },
    chapters: chapters.map(chapterToChapterText),
    audio: new Map(),
    meta,
  }
}

// ---------------------------------------------------------------------------
// ServerDatasource — LibraryDatasource over the Phase-2 endpoints
// ---------------------------------------------------------------------------

export interface CreateServerDatasourceOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export function createServerDatasource(
  opts: CreateServerDatasourceOptions = {},
): LibraryDatasource {
  // Lazy default: resolve the global at call time (not module load) so tests
  // can stub `fetch` after the singletons exist.
  const f = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const bookPath = (id: BookId): string => `/api/books/${encodeURIComponent(id)}`

  const unavailable = (op: string): HostedModeUnavailableError => new HostedModeUnavailableError(op)

  const getAllBooks = async (): Promise<Book[]> => {
    const dtos = await getJson<BookDto[]>(f, '/api/books')
    return dtos.map(toBook)
  }

  return {
    // --- books ---
    getAllBooks,

    async getBook(id: BookId) {
      const dto = await fetchBookDto(f, id)
      return dto ? toBook(dto) : undefined
    },

    async getMostRecentBook() {
      return (await getAllBooks())[0]
    },

    async putBook() {
      throw unavailable('Editing book metadata')
    },

    async deleteBookCascade(id: BookId) {
      await api(f, bookPath(id), { method: 'DELETE' })
    },

    async updateBookProgress(id: BookId, position: BookPosition, progressFraction: number) {
      try {
        await api(f, `${bookPath(id)}/progress`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...position, progressFraction }),
        })
      } catch (e) {
        // Mirror the local no-op-on-missing-book semantics (db/books.ts).
        if (notFound(e)) return
        throw e
      }
    },

    async updateBookProcessing() {
      throw unavailable('Recording applied processing')
    },

    // --- chapters ---
    async getChaptersByBook(id: BookId) {
      try {
        const dtos = await getJson<ChapterDto[]>(f, `${bookPath(id)}/chapters`)
        return dtos.map(toChapter)
      } catch (e) {
        // Local semantics: a book with no chapters (or no book) → [].
        if (notFound(e)) return []
        throw e
      }
    },

    async putChapters() {
      throw unavailable('Editing chapter text')
    },

    async replaceBookChapters() {
      throw unavailable('Regenerating the chapter outline')
    },

    async updateParagraph(): Promise<Chapter | undefined> {
      throw unavailable('Editing a paragraph')
    },

    // --- original file ---
    async getBookFile(): Promise<BookFile | undefined> {
      // Hosted upload is browser-side (ADR-0013); the original file is not
      // re-parsable server-side in v1 — outline re-detection degrades.
      throw unavailable('Accessing the original uploaded file')
    },

    // --- derived audio ---
    async getCachedParagraphIds(id: BookId, voice: VoiceId, chapters: Chapter[]) {
      const dto = await fetchBookDto(f, id)
      if (!dto?.audioPresent || dto.voiceId !== voice) return new Set<string>()
      // Whole-book synth under one voice → every non-empty paragraph has
      // audio. See the module doc for the strategy decision.
      const ids = new Set<string>()
      for (const ch of chapters) {
        for (const [i, text] of ch.paragraphs.entries()) {
          if (text.trim()) ids.add(`${ch.id}:${i}`)
        }
      }
      return ids
    },

    async getBookAudio(): Promise<BookAudio | undefined> {
      // Whole-book preloaded audio is a local/mobile-only encode (G20);
      // hosted playback streams per-paragraph (T15).
      return undefined
    },

    // --- derived audio: invalidation — the server owns the audio store;
    // a hosted transform invalidates by re-POST + resynth (T14), so there is
    // never anything local to enumerate or purge. ---
    async getAudioCacheKeysByBook() {
      return []
    },

    async deleteAudioCacheKeys() {
      return 0
    },

    async deleteBookAudio() {
      // No local record exists; nothing to drop.
    },

    // --- storage management — the audio cache is on-device only ---
    async getAudioCacheSize() {
      return 0
    },

    async clearAudioCache() {
      return 0
    },

    async clearSegmentCache() {
      return 0
    },

    async evictAudioCacheToBudget() {
      return 0
    },

    async clearAllStores() {
      // Hosted mode owns no local stores; server data is NOT wiped from the
      // client (Settings affordances are audited in T16).
    },

    // --- backup & transfer — local-mode features (hosted transfer is the
    // bundle download, a separate affordance) ---
    async exportBackup(): Promise<Blob> {
      throw unavailable('Local backup export')
    },

    async importBackup(): Promise<ImportReport> {
      throw unavailable('Local backup import')
    },
  }
}

// ---------------------------------------------------------------------------
// ServerSynthPipeline — the remote synth pipeline (T14)
// ---------------------------------------------------------------------------

export interface CreateServerSynthPipelineOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Voice stamped on text-only bundles at upload time (the server re-stamps
   * the manifest on synth completion, so this is pre-synth metadata only).
   */
  defaultVoiceId?: VoiceId
  /** `GET /api/jobs/:id` cadence in ms; tests pass small values. */
  pollIntervalMs?: number
}

/**
 * The hosted `SynthPipeline`: parse in workers → POST text-only bundle →
 * trigger server synth → poll the job into the local pipeline's `JobState`
 * shapes. No wake lock, no PoolEngine, no mobile whole-book encode — the
 * browser only watches; the server synthesizes.
 */
class RemoteSynthPipeline implements SynthPipeline {
  private readonly f: typeof fetch
  private readonly defaultVoice: VoiceId
  private readonly pollIntervalMs: number

  private job: JobState = { type: 'idle' }
  private readonly jobListeners = new Set<() => void>()

  private transform: BookTransformState = { type: 'idle' }
  private readonly transformListeners = new Set<() => void>()

  /** Set by `cancel()` — observed between poll ticks; the server job keeps running. */
  private stopPolling = false
  /** Last accepted spec, re-run by `retry()`. */
  private lastSpec: (JobSpec & { mode: 'initial' | 'resynth' }) | null = null

  /** Aborts the in-flight client-side transform loop. */
  private transformAbort: AbortController | null = null
  /** The running transform's book (title for `cancelTransformForBook`'s blocked result). */
  private transformBook: Book | null = null

  constructor(opts: CreateServerSynthPipelineOptions = {}) {
    // Lazy default (see createServerDatasource): tests stub the global late.
    this.f = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.defaultVoice = opts.defaultVoiceId ?? DEFAULT_VOICE_ID
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000
  }

  // --- external stores (arrow fields: stable references for
  // useSyncExternalStore) ---

  getState = (): JobState => this.job

  subscribe = (listener: () => void): (() => void) => {
    this.jobListeners.add(listener)
    return () => {
      this.jobListeners.delete(listener)
    }
  }

  getTransformState = (): BookTransformState => this.transform

  subscribeTransform = (listener: () => void): (() => void) => {
    this.transformListeners.add(listener)
    return () => {
      this.transformListeners.delete(listener)
    }
  }

  private setJobState(next: JobState): void {
    this.job = next
    for (const ln of this.jobListeners) ln()
  }

  private setTransformState(next: BookTransformState): void {
    this.transform = next
    for (const ln of this.transformListeners) ln()
  }

  isActive(): boolean {
    return this.job.type === 'synthesizing' || this.job.type === 'cancelling'
  }

  canPause(): boolean {
    // Server jobs run to completion — there is no cooperative pause.
    return false
  }

  canRetry(): boolean {
    return (
      this.job.type === 'error' &&
      (this.job.mode === 'resynth' || !!this.job.retryable) &&
      this.lastSpec !== null
    )
  }

  isRecovering(): boolean {
    return false
  }

  dismiss(): void {
    if (this.job.type === 'done' || this.job.type === 'error' || this.job.type === 'paused') {
      this.setJobState({ type: 'idle' })
    }
  }

  // --- upload ---

  async ingestBook(file: File): Promise<IngestResult> {
    const format = formatForFile(file.name)
    if (!format) throw new UnsupportedFileError(file.name)
    const parsed = await parseInWorker(file)
    const now = Date.now()
    const id = newBookId()
    // Chapter ids use the server's derived scheme (`ch_<bookId>_<idx>`, T9) so
    // the parse result agrees with every later `GET /chapters` fetch.
    // Egress cleaning (T15 key parity): the server synthesizes the bundle's
    // stored text and the reader plays its cleaned view of that text — keys
    // only agree when the two are the same string, so the user's cleaning
    // config is applied HERE, before the bundle is written. The returned
    // chapters mirror the bundle so the post-upload transform path re-POSTs
    // cleaned text too.
    const cleaning = await readCleaningConfig()
    const chapters: Chapter[] = cleanChapters(
      parsed.chapters.map((parsedChapter, index) => ({
        id: chapterId(`ch_${id}_${index}`),
        bookId: id,
        index,
        title: parsedChapter.title,
        paragraphs: parsedChapter.paragraphs,
      })),
      cleaning,
    )
    const provisional: Book = {
      id,
      title: parsed.title,
      format,
      chapterCount: chapters.length,
      createdAt: now,
      updatedAt: now,
    }
    const bytes = await writeBookBundle(textOnlyBundle(provisional, chapters, this.defaultVoice))
    const dto = await this.postBundle(id, bytes)
    return { book: toBook(dto), chapters }
  }

  /** POST a text-only bundle as multipart — the idempotent-upsert egress. */
  private async postBundle(id: BookId, bytes: Uint8Array): Promise<BookDto> {
    const form = new FormData()
    form.append(
      'bundle',
      // jszip hands back `Uint8Array<ArrayBufferLike>`; a Blob wants a plain
      // ArrayBuffer part. generateAsync returns an exact-size buffer, so the
      // view's underlying buffer is the whole payload.
      new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }),
      `${encodeURIComponent(id)}.taletrek`,
    )
    const res = await api(this.f, '/api/books', { method: 'POST', body: form })
    const dtos = (await res.json()) as BookDto[]
    const dto = dtos.find((d) => d.id === id) ?? dtos[0]
    if (!dto) throw new ServerApiError('upload response carried no book', res.status)
    return dto
  }

  // --- synth job ---

  startJob(spec: JobSpec): void {
    if (this.isActive()) throw new Error('A synthesis job is already running')
    this.launchJob(spec)
  }

  /**
   * Set the synthesizing state + kick the async run — shared by `startJob`
   * (throwing re-entry guard) and the post-transform chain (quiet skip when a
   * job is somehow already active, mirroring the local manager's
   * `triggerResynth`).
   */
  private launchJob(spec: JobSpec): void {
    if (this.isActive()) return
    const resolved = { ...spec, mode: spec.mode ?? 'initial' } as JobSpec & {
      mode: 'initial' | 'resynth'
    }
    this.lastSpec = resolved
    this.stopPolling = false
    // Flip synchronously so the re-entry guard above holds for immediate
    // second calls (mirrors the local manager's contract).
    this.setJobState({
      type: 'synthesizing',
      book: spec.book,
      done: 0,
      total: 0,
      synthesizedParagraphIds: new Set(),
      mode: resolved.mode,
    })
    void this.runJob(resolved)
  }

  private async runJob(spec: JobSpec & { mode: 'initial' | 'resynth' }): Promise<void> {
    const { book, voiceId, mode } = spec
    try {
      const dto = await fetchBookDto(this.f, book.id)
      if (!dto) {
        throw new ServerApiError(`"${book.title}" is not on the server — upload it again`, 404)
      }
      // A book that already has audio takes the resynth endpoint (`synth`
      // would 409 AlreadyFull). Covers the mode:'initial' race after another
      // session's job completed.
      const useResynth = mode === 'resynth' || dto.audioPresent
      const trigger = `/api/books/${encodeURIComponent(book.id)}/${useResynth ? 'resynth' : 'synth'}`
      try {
        const { jobId } = await postJson<{ jobId: string }>(this.f, trigger, { voice: voiceId })
        await this.pollLoop(jobId, book, mode)
      } catch (e) {
        if (e instanceof ServerApiError && e.status === 409) {
          // One job per book server-side: another run (often this session's
          // own cancelled watch, or a second tab) owns the book. Adopt it.
          const adopted = await this.adoptInFlightForBook(book, mode)
          if (adopted) return
        }
        throw e
      }
    } catch (e) {
      if (this.stopPolling) return // cancelled before/during the trigger
      this.setJobState({
        type: 'error',
        book,
        message: e instanceof Error ? e.message : 'Synthesis failed',
        mode,
        retryable: true,
      })
    } finally {
      // Cancel-safety net: if the trigger was in flight when `cancel()` fired,
      // nothing else will complete the cancelling → idle transition.
      if (this.stopPolling && this.job.type === 'cancelling') {
        this.setJobState({ type: 'idle' })
      }
    }
  }

  /**
   * Poll a server job into the local `JobState` shapes. `queued`/`running`
   * tick `synthesizing.done/total`; terminal statuses settle the banner.
   * Mid-`synthesizing` paragraph identity is unknowable client-side (the
   * bundle is rewritten atomically at completion), so
   * `synthesizedParagraphIds` stays empty — matching the T13 audio-probe
   * contract that reports nothing until the job completes.
   */
  private async pollLoop(jobId: string, book: Book, mode: 'initial' | 'resynth'): Promise<void> {
    const jobPath = `/api/jobs/${encodeURIComponent(jobId)}`
    for (;;) {
      if (this.stopPolling) break
      let dto: JobDto
      try {
        dto = await getJson<JobDto>(this.f, jobPath)
      } catch (e) {
        if (e instanceof ServerApiError && e.isUnauthorized) {
          this.setJobState({
            type: 'error',
            book,
            message: 'Session expired — log in again to keep watching the job.',
            mode,
            retryable: true,
          })
          return
        }
        if (e instanceof ServerApiError && e.status === 404) {
          this.setJobState({
            type: 'error',
            book,
            message: 'The server job disappeared — retry synthesis.',
            mode,
            retryable: true,
          })
          return
        }
        // Transient (offline blip): keep watching — the server is the source
        // of truth and the job does not pause when we can't see it.
        await this.sleep()
        continue
      }
      if (dto.status === 'succeeded') {
        this.setJobState({ type: 'done', book, mode })
        return
      }
      if (dto.status === 'failed') {
        this.setJobState({
          type: 'error',
          book,
          message: dto.error ?? 'Synthesis failed on the server',
          mode,
          retryable: true,
        })
        return
      }
      const s = this.job
      if (!this.stopPolling && s.type === 'synthesizing') {
        this.setJobState({
          ...s,
          done: dto.done,
          total: dto.total,
          synthesizedParagraphIds: new Set(),
        })
      }
      await this.sleep()
    }
    if (this.job.type === 'cancelling') this.setJobState({ type: 'idle' })
  }

  /** True when a non-terminal job for the book exists (recent-50 window). */
  private async findInFlightJob(bookId: BookId): Promise<JobDto | undefined> {
    const jobs = await getJson<JobDto[]>(this.f, '/api/jobs').catch(() => [])
    return jobs.find(
      (j) => j.bookId === bookId && (j.status === 'queued' || j.status === 'running'),
    )
  }

  /**
   * Recent jobs across books for the library's per-book status chips (T16).
   * Best-effort: an unreachable server degrades to `[]` — the chips are
   * informational, never load-bearing.
   */
  async listRecentJobs(): Promise<RecentJob[]> {
    try {
      const jobs = await getJson<JobDto[]>(this.f, '/api/jobs')
      return jobs.map(toRecentJob)
    } catch {
      return []
    }
  }

  /** Re-attach the poll loop to an already-running server job. */
  private async adoptInFlightForBook(book: Book, mode: 'initial' | 'resynth'): Promise<boolean> {
    const job = await this.findInFlightJob(book.id)
    if (!job) return false
    const s = this.job
    if (!this.stopPolling && s.type === 'synthesizing') {
      this.setJobState({ ...s, done: job.done, total: job.total })
    }
    await this.pollLoop(job.id, book, mode)
    return true
  }

  /**
   * Cancel the client's watch on the running job: stops polling and returns
   * the banner to idle. **The server-side job keeps running** — synthesis is
   * server-owned in hosted mode and there is no abort endpoint. Closing the
   * tab has the same effect; reload (or the boot recovery) re-adopts the job
   * from `GET /api/jobs`, and the book simply shows ready when it completes.
   */
  cancel(): void {
    if (!this.isActive()) return
    const s = this.job
    if (s.type !== 'synthesizing') return // already cancelling
    this.stopPolling = true
    this.setJobState({ type: 'cancelling', book: s.book, mode: s.mode })
  }

  retry(): void {
    if (this.job.type !== 'error' || !this.canRetry() || !this.lastSpec) return
    this.startJob(this.lastSpec)
  }

  /**
   * No client-side job bookkeeping exists hosted, so there is nothing to
   * cancel before a delete — `no-op`. The server's own guard is
   * authoritative: `DELETE` answers 409 while a synth job runs for the
   * book.
   */
  async cancelForBook(_bookId: BookId): Promise<CancelForBookResult> {
    return { type: 'no-op' }
  }

  // --- reload recovery (R5) ---

  /**
   * Re-adopt an in-flight server job after a reload (R5): the tab closing
   * mid-synth never pauses anything server-side, so on boot in server mode
   * `main.tsx` calls this — any non-terminal job in the recent-50 list is
   * re-attached to the poll loop and the processing display resumes. Jobs
   * that completed while away need no recovery: the book's `audioPresent`
   * already shows ready. Best-effort and silent — an unreachable server
   * leaves the pipeline idle.
   */
  async recoverInFlightJobs(): Promise<void> {
    if (this.isActive()) return
    const jobs = await getJson<JobDto[]>(this.f, '/api/jobs').catch(() => [])
    const job = jobs.find((j) => j.status === 'queued' || j.status === 'running')
    if (!job) return
    const dto = await fetchBookDto(this.f, bookId(job.bookId)).catch(() => undefined)
    if (!dto) return
    const mode: 'initial' | 'resynth' = job.kind === 'resynth' ? 'resynth' : 'initial'
    const book = toBook(dto)
    this.stopPolling = false
    this.setJobState({
      type: 'synthesizing',
      book,
      done: job.done,
      total: job.total,
      synthesizedParagraphIds: new Set(),
      mode,
    })
    void this.pollLoop(job.id, book, mode)
  }

  /** Adopt + watch any in-flight server job for a book (library Resume). */
  async resume(bookId: BookId): Promise<void> {
    if (this.isActive()) return
    const job = await this.findInFlightJob(bookId).catch(() => undefined)
    if (!job) return
    const dto = await fetchBookDto(this.f, bookId).catch(() => undefined)
    if (!dto) return
    const mode: 'initial' | 'resynth' = job.kind === 'resynth' ? 'resynth' : 'initial'
    const book = toBook(dto)
    this.stopPolling = false
    this.setJobState({
      type: 'synthesizing',
      book,
      done: job.done,
      total: job.total,
      synthesizedParagraphIds: new Set(),
      mode,
    })
    void this.pollLoop(job.id, book, mode)
  }

  pause(): void {
    throw new HostedModeUnavailableError('Pausing synthesis')
  }

  // --- hosted whole-book AI transform ---

  /**
   * The transform corner of ADR-0014: AI transforms run **client-side**
   * (keys never leave the browser) over in-memory chapters. On completion the
   * transformed text is serialized to a fresh text-only bundle and re-POSTed
   * (same book id → idempotent upsert; the old-voice audio is discarded with
   * it) and synthesis is re-triggered — `resynth` under the book's *current*
   * voice when it already had audio, else a first `synth` under the spec's.
   * Operational failures surface via `getTransformState()` (error variant),
   * never throws — mirroring the local manager's contract.
   */
  async startTransform(spec: TransformJobSpec, deps: TransformRunDeps): Promise<void> {
    const failSync = (message: string): void => {
      this.setTransformState({ type: 'error', bookId: spec.book.id, message })
    }
    if (this.transform.type === 'running' || this.transform.type === 'paused') {
      failSync('A book transform is already in progress.')
      return
    }
    if ((spec.ops?.length ?? 0) === 0) {
      failSync('No transform ops selected.')
      return
    }
    if (!deps.ai.enabled) {
      failSync('AI is not enabled — open Settings → AI.')
      return
    }

    // Pre-state probe, BEFORE the loop + re-POST: whether the book currently
    // has audio decides synth vs resynth and fixes the book's current voice.
    // After a text-only re-POST `audioPresent` is false by then, so the
    // decision must be captured up front.
    let dto: BookDto | undefined
    try {
      dto = await fetchBookDto(this.f, spec.book.id)
    } catch (e) {
      failSync(e instanceof Error ? e.message : 'Could not reach the server.')
      return
    }
    if (!dto) {
      failSync('Book not found on the server.')
      return
    }

    this.transformAbort = new AbortController()
    this.transformBook = spec.book
    await this.runTransformLoop(spec, deps, dto)
  }

  private failTransform(bookId: BookId, message: string): void {
    this.setTransformState({ type: 'error', bookId, message })
  }

  private async runTransformLoop(
    spec: TransformJobSpec,
    deps: TransformRunDeps,
    dto: BookDto,
  ): Promise<void> {
    const { book, chapters } = spec

    // Resolve defs + engines upfront (mirrors the local loop's pre-checks).
    const pairs: Array<{
      op: TransformJobSpec['ops'][number]
      def: TransformRunDeps['defs'][number]
      engine: NonNullable<ReturnType<typeof getAiEngineForDef>>
    }> = []
    for (const op of spec.ops) {
      const def = deps.defs.find((d) => d.id === op.defId)
      if (!def) {
        this.failTransform(book.id, `Transform "${op.defId}" not found — it may have been deleted.`)
        return
      }
      const engine = getAiEngineForDef(deps.ai, def)
      if (!engine) {
        this.failTransform(
          book.id,
          `No provider configured for "${def.label}". Open Settings → AI and configure a provider.`,
        )
        return
      }
      pairs.push({ op, def, engine })
    }

    const total = pairs.length * chapters.length
    this.setTransformState({
      type: 'running',
      bookId: book.id,
      opLabel: pairs[0]?.def.label ?? '',
      currentOpIndex: 0,
      totalOps: pairs.length,
      currentChapterIndex: 0,
      totalChapters: chapters.length,
      done: 0,
      total,
      chapterStartedAt: performance.now(),
      // Hosted transforms keep chapters in memory only; the live in-place
      // paragraph rendering is a local-reader affordance and stays null here.
      streamingParagraphs: null,
    })

    let working = chapters
    let done = 0
    try {
      for (const [i, { op, def, engine }] of pairs.entries()) {
        for (const [c, chapter] of working.entries()) {
          if (this.transformAbort?.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError')
          }
          const out = await engine.transform(
            chapter.paragraphs,
            op,
            def,
            undefined,
            this.transformAbort?.signal,
          )
          working = working.map((ch, idx) => (idx === c ? { ...chapter, paragraphs: out } : ch))
          done += 1
          const s = this.transform
          if (s.type === 'running') {
            this.setTransformState({
              ...s,
              currentOpIndex: i,
              currentChapterIndex: c,
              done,
              total,
              chapterStartedAt: performance.now(),
            })
          }
        }
      }
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') {
        // Cancel: nothing was committed server-side — the in-memory output is
        // dropped wholesale and the transform goes back to idle.
        this.setTransformState({ type: 'idle' })
      } else {
        this.failTransform(book.id, (e as Error)?.message || 'Transform failed.')
      }
      return
    } finally {
      this.transformAbort = null
      this.transformBook = null
    }

    // Transform succeeded — submit: re-POST the transformed text-only bundle
    // (idempotent upsert under the same book id), stamping the intended
    // voice + the applied-processing record into the bundle's meta.
    const voice: VoiceId = dto.audioPresent ? (dto.voiceId as VoiceId) : spec.voiceId
    try {
      const bytes = await writeBookBundle(
        textOnlyBundle(book, working, voice, {
          processing: { appliedAt: Date.now(), ops: spec.ops },
        }),
      )
      await this.postBundle(book.id, bytes)
    } catch (e) {
      this.failTransform(
        book.id,
        `Transform succeeded but uploading the transformed text failed: ${
          e instanceof Error ? e.message : 'network error'
        }`,
      )
      return
    }

    // Reset the reading position to the chapter start (local parity — the
    // M6 decision: a transform invalidates the old paragraphIndex).
    const chapterIndex = book.position?.chapterIndex ?? 0
    await api(this.f, `/api/books/${encodeURIComponent(book.id)}/progress`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterIndex, paragraphIndex: 0, progressFraction: 0 }),
    }).catch(() => {})

    this.setTransformState({ type: 'done', bookId: book.id })

    // Chain synthesis (sequential, resynth-safe — mirrors the local manager).
    if (deps.synthEnabled) {
      this.launchJob({
        book: { ...book, updatedAt: Date.now() },
        chapters: working,
        voiceId: voice,
        cleaning: spec.cleaning,
        mode: dto.audioPresent ? 'resynth' : 'initial',
      })
    }
  }

  async resumeTransform(_bookId: BookId): Promise<void> {
    // Hosted transforms are in-memory only — a reload drops the output, so
    // there is no persisted job to resume. Re-run from the modal instead.
    throw new HostedModeUnavailableError('Resuming a transform')
  }

  pauseTransform(): void {
    throw new HostedModeUnavailableError('Pausing a transform')
  }

  /** Abort the running loop; already-completed chapters are dropped (nothing
   * was committed server-side — the re-POST happens only at completion). */
  async cancelTransform(): Promise<void> {
    if (this.transform.type !== 'running') return
    this.transformAbort?.abort()
    await this.waitForTransformSettled()
  }

  async cancelTransformForBook(bookId: BookId): Promise<CancelForBookResult> {
    if (this.transform.type !== 'running' && this.transform.type !== 'paused') {
      return { type: 'no-op' }
    }
    if (this.transform.bookId !== bookId) {
      return { type: 'blocked', activeBookTitle: this.transformBook?.title ?? 'another book' }
    }
    await this.cancelTransform()
    return { type: 'cancelled' }
  }

  /** Resolve once the transform reaches a non-active state (bounded). */
  private waitForTransformSettled(): Promise<void> {
    return new Promise((resolve) => {
      const settled = () => this.transform.type !== 'running'
      if (settled()) {
        resolve()
        return
      }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        unsubscribe()
        clearTimeout(timer)
        resolve()
      }
      const unsubscribe = this.subscribeTransform(() => {
        if (settled()) finish()
      })
      const timer = setTimeout(finish, 5000)
    })
  }

  async reparseChapters(_bookId: BookId): Promise<Chapter[]> {
    // Hosted upload is browser-side (ADR-0013) and the original file is not
    // stored server-side — there is nothing pristine to re-parse from.
    throw new HostedModeUnavailableError('Reprocessing from the original file')
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
  }
}

export function createServerSynthPipeline(
  opts: CreateServerSynthPipelineOptions = {},
): RemoteSynthPipeline {
  return new RemoteSynthPipeline(opts)
}

/** Default singletons for the provider (one server shape per session). */
export const serverDatasource: LibraryDatasource = createServerDatasource()
export const serverSynthPipeline: RemoteSynthPipeline = createServerSynthPipeline()
