export type BookId = string & { readonly __brand: 'BookId' }
export type ChapterId = string & { readonly __brand: 'ChapterId' }
export type VoiceId = string & { readonly __brand: 'VoiceId' }

/** Id of a transform definition. Historical (M6 AI transforms, removed by
 * the native pivot — ADR-0015); retained because `AppliedProcessing` is
 * part of the `.taletrek` manifest format and stored book records. */
export type TransformDefId = string

/** Construct a {@link TransformDefId} from a raw string. */
export function transformDefId(value: string): TransformDefId {
  return value as TransformDefId
}

/** A single scheduled transform op — definition id + runtime params. Format-compat. */
export interface TransformOp {
  defId: TransformDefId
  params: Record<string, string | number>
}

/** Last applied processing on a book; serialized into `meta/processing.json`
 * inside `.taletrek` bundles. Format-compat. */
export interface AppliedProcessing {
  appliedAt: number
  ops: TransformOp[]
}

export type BookFormat = 'pdf' | 'epub' | 'mobi' | 'txt' | 'md' | 'html' | 'docx'

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
  /**
   * Voice the book's audio was synthesized under. Set at bundle import (the
   * manifest's `book.voiceId`); legacy pre-pivot books may lack it — callers
   * fall back to the stored default voice.
   */
  voiceId?: VoiceId
  /** Last applied processing (historical, M6-era); `undefined` = unprocessed. Part of the bundle format. */
  processing?: AppliedProcessing
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
