import type { AppliedProcessing, TransformOp } from './lib/ai/types'
import type { CleaningConfig } from './lib/clean/types'

export type BookId = string & { readonly __brand: 'BookId' }
export type ChapterId = string & { readonly __brand: 'ChapterId' }
export type VoiceId = string & { readonly __brand: 'VoiceId' }

export type BookFormat = 'pdf' | 'epub' | 'mobi' | 'txt' | 'md'

export interface BookPosition {
  chapterIndex: number
  paragraphIndex: number
}

/** A navigable sub-heading within a chapter (Level 2 outline entry). */
export interface ChapterHeading {
  /** Index within the chapter's `paragraphs` array. */
  paragraphIndex: number
  title: string
}

export interface Book {
  id: BookId
  title: string
  format: BookFormat
  chapterCount: number
  createdAt: number
  updatedAt: number
  /** Last reading position; `undefined` means not started (M5). */
  position?: BookPosition
  /** Fraction of paragraphs consumed (0..1), for the library progress bar (M5). */
  progressFraction?: number
  /** Last applied AI processing (M6); `undefined` = unprocessed. Originals stay recoverable via `getBookFile` + re-parse. */
  processing?: AppliedProcessing
  /** True while upload (synth + concat+encode) is in progress. Library badges it. */
  uploading?: boolean
  /**
   * A synthesis job paused mid-book (ADR-0010 / M11). When present, the book is
   * resumable from the library. `uploading` is `false` while paused, so the boot
   * sweep (ADR-0009) ignores it — only explicit user pause becomes resumable;
   * true interruptions stay sweep-governed.
   */
  uploadJob?: PersistedUploadJob
  /**
   * True while a whole-book AI streaming transform (M13 / ADR-0012) is running.
   * Library badges it; reader blocks Play while set.
   */
  transforming?: boolean
  /**
   * A whole-book AI transform job, persisted on the book record (M13 /
   * ADR-0012). When present, the book is resumable from the library. Mirrors
   * `uploadJob`: `transforming` is `false` while paused, so the boot sweep's
   * transform pass ignores explicit pauses; true interruptions stay governed.
   */
  transformJob?: PersistedTransformJob
}

/**
 * A paused synthesis job's resumable spec, persisted on the book record.
 * Resume reloads chapters from IDB and re-runs this spec; the M8 cache
 * fast-forwards through already-synthesized paragraphs.
 *
 * Persisted from `runJob` start (not only on explicit pause) so an
 * interrupted initial upload (iOS tab eviction, crash) survives the
 * ADR-0009 boot sweep as a resumable paused book. `done` is bumped per-¶;
 * `lastFlatIndex` / `lastChapterTitle` / etc. carry the paragraph the
 * synth died on so the post-eviction library card can show it.
 */
export interface PersistedUploadJob {
  voiceId: VoiceId
  cleaning: CleaningConfig
  /** `'initial'` (fresh upload) or `'resynth'` (re-synthesize). */
  mode: 'initial' | 'resynth'
  /** Paragraphs synthesized before the pause (best-effort, for UI display). */
  done: number
  /** Total paragraphs in the job (best-effort, for UI display). */
  total: number
  /** Date.now() at pause time. */
  pausedAt: number
  /** Flat index of the paragraph currently (or last) being synthesized. */
  lastFlatIndex?: number
  /** Chapter title where the synth is/was sitting. */
  lastChapterTitle?: string
  /** Paragraph-within-chapter (1-based, non-empty paragraphs only) of the last attempt. */
  lastParagraphInChapter?: number
  /** Total non-empty paragraphs in the chapter containing the last attempt. */
  lastChapterTotal?: number
}

/**
 * A paused whole-book AI transform's resumable spec (M13 / ADR-0012). Resume
 * reloads chapters from IDB and re-runs this spec from `(currentOpIndex,
 * currentChapterIndex)`; already-committed chapters survive any interruption
 * (the M8 audio cache is content-addressed, so cached paragraphs fast-forward
 * for free).
 *
 * Granularity is **chapter-level** (the unit at which `engine.transform`
 * commits and `putChapters` writes). Within-chapter state is never persisted —
 * chunks only commit at their boundary, so an interrupted chunk has no partial
 * state to reconcile.
 */
export interface PersistedTransformJob {
  /** Ordered list of transform ops to apply (each feeds the next). */
  ops: TransformOp[]
  voiceId: VoiceId
  cleaning: CleaningConfig
  /** Outer-loop index (which op to resume from). */
  currentOpIndex: number
  /** Inner-loop index (which chapter to resume from, within the working set). */
  currentChapterIndex: number
  /** Chapter-units completed across all ops (for UI progress). */
  done: number
  /** Total chapter-units across all ops (for UI progress). */
  total: number
  /** Date.now() at pause time. */
  pausedAt: number
}

export interface Chapter {
  id: ChapterId
  bookId: BookId
  index: number
  title: string
  paragraphs: string[]
  /** Sub-headings within this chapter (Level 2 outline entries). Optional — older books have none. */
  headings?: ChapterHeading[]
}

export interface BookFile {
  bookId: BookId
  blob: Blob
  name: string
  type: string
  size: number
}

/**
 * A cached TTS audio blob keyed content-addressedly (M8). The key is
 * `${voiceId}:${NORM_VERSION}:${sha256(normalizeForSpeech(text))}`; this record
 * is the value. Stored in the `audioCache` IndexedDB store (v3).
 */
export interface AudioCacheRecord {
  /** Denormalized cache key — `${voiceId}:${NORM_VERSION}:${sha256(normalized)}`. */
  key: string
  /** WAV blob (22050 Hz mono 16-bit per the Piper spike). */
  blob: Blob
  /**
   * Book this entry belongs to. Optional: entries synthesized without a book
   * context (e.g. tests, ad-hoc synth) are still cached but not reachable via
   * the `bookId` index — IndexedDB skips undefined index values, so they're
   * immune to cascade clear and only reaped by LRU.
   */
  bookId?: BookId
  /** blob.size at write time — drives budget accounting. */
  sizeBytes: number
  /** Original synthesis wall-clock ms — for diagnostics only. */
  synthMs: number
  /** Audio duration in seconds, parsed from the WAV. */
  durationSeconds: number
  /** Voice that produced this audio — for future per-voice clear. */
  voiceId: VoiceId
  /** Date.now() at last hit/insert — drives LRU eviction. */
  lastUsed: number
  /** Date.now() at first insert. */
  createdAt: number
}

export function bookId(value: string): BookId {
  return value as BookId
}

export function chapterId(value: string): ChapterId {
  return value as ChapterId
}

export function newBookId(): BookId {
  return bookId(crypto.randomUUID())
}

export function newChapterId(): ChapterId {
  return chapterId(crypto.randomUUID())
}

export function voiceId(value: string): VoiceId {
  return value as VoiceId
}

/**
 * A cached fMP4 segment for mobile MSE streaming (M9). Keyed identically to
 * `AudioCacheRecord` (`${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`).
 * Stored in the `audioSegments` IndexedDB store (v4).
 */
export interface AudioSegmentRecord {
  /** Same key scheme as M8: `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`. */
  key: string
  /** The fMP4 blob (AAC audio + 1x1 black H.264 video). */
  blob: Blob
  /** Paragraph audio duration in seconds (for time-offset table). */
  duration: number
  /** For per-book cascade clear. */
  bookId?: BookId
  /** blob.size at write time — drives budget accounting. */
  sizeBytes: number
  /** For LRU eviction. */
  lastUsed: number
  /** Date.now() at first insert. */
  createdAt: number
}
