import type { AppliedProcessing } from './lib/ai/types'

export type BookId = string & { readonly __brand: 'BookId' }
export type ChapterId = string & { readonly __brand: 'ChapterId' }
export type VoiceId = string & { readonly __brand: 'VoiceId' }

export type BookFormat = 'pdf' | 'epub' | 'mobi' | 'txt'

export interface BookPosition {
  chapterIndex: number
  paragraphIndex: number
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
}

export interface Chapter {
  id: ChapterId
  bookId: BookId
  index: number
  title: string
  paragraphs: string[]
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
