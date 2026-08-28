/**
 * Server implementation of the datasource seam (ADR-0014, Effort 5 · T13):
 * the SPA hosted by the personal server, talking same-origin HTTP with
 * implicit cookie auth (set by the `/ui/login` gate).
 *
 * Implemented here (T13) — the library surface: books list/get (BookDto →
 * SPA `Book`, position from T11), chapters (T9 wire shape → SPA `Chapter`),
 * progress PATCH (T11), delete, and audio-presence probing. Thrown as
 * "not available in hosted mode" stubs: the `SynthPipeline` operations (T14 —
 * upload/parse-orchestration/transform) and local-only library surfaces whose
 * hosted equivalents are later tasks (paragraph edits, original file access,
 * backup). The pipeline's *queries* (`getState`, `isActive`, …) return passive
 * values rather than throwing so mount-path subscribers (`useSyncExternalStore`
 * in `useUploadState` / the transform banner) stay inert in server mode.
 *
 * # Audio probing strategy (decided here, per T13)
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
import { bookId, chapterId } from '../../types'
import type { ImportReport } from '../backup'
import type { BookAudio } from '../book-audio'
import type { IngestResult } from '../ingest'
import type { TtsEngine } from '../tts/types'
import type {
  BookTransformState,
  CancelForBookResult,
  JobSpec,
  JobState,
  LibraryDatasource,
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

async function api(fetchImpl: typeof fetch, path: string, init?: RequestInit): Promise<Response> {
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

function notFound(e: unknown): boolean {
  return e instanceof ServerApiError && e.status === 404
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
  const f = opts.fetchImpl ?? fetch
  const bookPath = (id: BookId): string => `/api/books/${encodeURIComponent(id)}`

  const fetchBookDto = async (id: BookId): Promise<BookDto | undefined> => {
    try {
      return await getJson<BookDto>(f, bookPath(id))
    } catch (e) {
      if (notFound(e)) return undefined
      throw e
    }
  }

  const unavailable = (op: string): HostedModeUnavailableError => new HostedModeUnavailableError(op)

  const getAllBooks = async (): Promise<Book[]> => {
    const dtos = await getJson<BookDto[]>(f, '/api/books')
    return dtos.map(toBook)
  }

  return {
    // --- books ---
    getAllBooks,

    async getBook(id: BookId) {
      const dto = await fetchBookDto(id)
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
      const dto = await fetchBookDto(id)
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
// ServerSynthPipeline — stub until T14 (remote synth pipeline)
// ---------------------------------------------------------------------------

/** Cached idle snapshots — `useSyncExternalStore` needs reference stability. */
const IDLE_JOB: JobState = { type: 'idle' }
const IDLE_TRANSFORM: BookTransformState = { type: 'idle' }

export function createServerSynthPipeline(): SynthPipeline {
  const unavailable = (op: string): HostedModeUnavailableError => new HostedModeUnavailableError(op)

  return {
    ingestBook: async (): Promise<IngestResult> => {
      throw unavailable('Upload')
    },

    startJob: (_spec: JobSpec): void => {
      throw unavailable('Synthesis')
    },

    isActive: () => false,
    canPause: () => false,
    canRetry: () => false,
    isRecovering: () => false,

    resume: async (): Promise<void> => {
      throw unavailable('Resuming a paused job')
    },

    pause: (): void => {
      throw unavailable('Pausing synthesis')
    },

    cancel: (): void => {
      throw unavailable('Cancelling synthesis')
    },

    retry: (): void => {
      throw unavailable('Retrying synthesis')
    },

    dismiss: (): void => {
      throw unavailable('Dismissing the job banner')
    },

    /**
     * No client-side job exists in hosted mode, so there is nothing to
     * cancel before a delete — `no-op`. The server's own guard is
     * authoritative: `DELETE` answers 409 while a synth job runs for the
     * book.
     */
    cancelForBook: async (_bookId: BookId): Promise<CancelForBookResult> => ({ type: 'no-op' }),

    subscribe:
      (_listener: () => void): (() => void) =>
      () => {},

    getState: (): JobState => IDLE_JOB,

    startTransform: async (_spec: TransformJobSpec, _deps: TransformRunDeps): Promise<void> => {
      throw unavailable('Whole-book AI transform')
    },

    resumeTransform: async (): Promise<void> => {
      throw unavailable('Resuming a transform')
    },

    pauseTransform: (): void => {
      throw unavailable('Pausing a transform')
    },

    cancelTransform: async (): Promise<void> => {
      throw unavailable('Cancelling a transform')
    },

    cancelTransformForBook: async (_bookId: BookId): Promise<CancelForBookResult> => ({
      type: 'no-op',
    }),

    subscribeTransform:
      (_listener: () => void): (() => void) =>
      () => {},

    getTransformState: (): BookTransformState => IDLE_TRANSFORM,

    reparseChapters: async (): Promise<Chapter[]> => {
      throw unavailable('Reprocessing from the original file')
    },
  }
}

/** Default singletons for the provider (one server shape per session). */
export const serverDatasource: LibraryDatasource = createServerDatasource()
export const serverSynthPipeline: SynthPipeline = createServerSynthPipeline()

/**
 * Interim hosted playback engine (T13): occupies the players' engine slot in
 * server mode so on-device Piper never loads hosted (locked decision: synth
 * is server-side only in the hosted shape). `synthesize` refuses — the
 * player surfaces the error instead of downloading a voice model. T15
 * replaces the body with audio-by-key fetches through this same slot.
 */
export const serverPlaybackEngine: TtsEngine = {
  async synthesize(): Promise<never> {
    throw new HostedModeUnavailableError('On-device playback synthesis')
  },
  async listVoices() {
    return []
  },
  async isStored() {
    return false
  },
  async download() {
    throw new HostedModeUnavailableError('Downloading on-device voices')
  },
  async remove() {
    // Nothing is ever stored hosted — no-op.
  },
  async clearAllStored() {
    // Nothing is ever stored hosted — no-op.
  },
}
