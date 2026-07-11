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
