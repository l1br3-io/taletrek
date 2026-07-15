import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import type {
  AudioCacheRecord,
  AudioSegmentRecord,
  Book,
  BookFile,
  BookId,
  Chapter,
  ChapterId,
  VoiceId,
} from '../../types'

/**
 * TaleTrek IndexedDB schema.
 *
 * v1 (M0): `settings` store only.
 * v2 (M1): adds `books`, `chapters`, and `files` stores for the ingest pipeline.
 * v3 (M8): adds `audioCache` store for the persistent TTS audio cache.
 * v4 (M9): adds `audioSegments` store for mobile fMP4 streaming segments.
 */
export interface TaleTrekDB extends DBSchema {
  settings: {
    key: string
    value: unknown
  }
  books: {
    key: BookId
    value: Book
    indexes: { updatedAt: number }
  }
  chapters: {
    key: ChapterId
    value: Chapter
    indexes: { bookId: BookId }
  }
  files: {
    key: BookId
    value: BookFile
  }
  audioCache: {
    key: string
    value: AudioCacheRecord
    indexes: { bookId: BookId; lastUsed: number }
  }
  audioSegments: {
    key: string
    value: AudioSegmentRecord
    indexes: { bookId: BookId; lastUsed: number }
  }
  bookAudio: {
    key: BookId
    value: {
      bookId: BookId
      blob: Blob
      duration: number
      paragraphOffsets: number[]
      durations: number[]
      voiceId: VoiceId
      createdAt: number
    }
  }
}

const DB_NAME = 'taletrek'
const DB_VERSION = 5

/** Soft cap on the audio cache (M8). ~1,700 paragraphs at ~300 KB/para. */
export const AUDIO_CACHE_BUDGET_BYTES = 500 * 1024 * 1024

let dbPromise: Promise<IDBPDatabase<TaleTrekDB>> | null = null

/** Open (and memoize) the TaleTrek database. Safe to call repeatedly. */
export function getDB(): Promise<IDBPDatabase<TaleTrekDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TaleTrekDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings')
          }
        }
        // v2
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('books')) {
            db.createObjectStore('books', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
          }
          if (!db.objectStoreNames.contains('chapters')) {
            db.createObjectStore('chapters', { keyPath: 'id' }).createIndex('bookId', 'bookId')
          }
          if (!db.objectStoreNames.contains('files')) {
            db.createObjectStore('files', { keyPath: 'bookId' })
          }
        }
        // v3 (M8)
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains('audioCache')) {
            const store = db.createObjectStore('audioCache', { keyPath: 'key' })
            store.createIndex('bookId', 'bookId')
            store.createIndex('lastUsed', 'lastUsed')
          }
        }
        // v4 (M9)
        if (oldVersion < 4) {
          if (!db.objectStoreNames.contains('audioSegments')) {
            const store = db.createObjectStore('audioSegments', { keyPath: 'key' })
            store.createIndex('bookId', 'bookId')
            store.createIndex('lastUsed', 'lastUsed')
          }
        }
        // v5 (M9 Path A): bookAudio store for pre-baked M4A blobs
        if (oldVersion < 5) {
          if (!db.objectStoreNames.contains('bookAudio')) {
            db.createObjectStore('bookAudio', { keyPath: 'bookId' })
          }
        }
      },
    })
  }
  return dbPromise
}

/** Reset the memoized connection — test-only escape hatch. */
export function _resetDBForTests(): void {
  dbPromise = null
}

/** Clear every store — used by the "Delete all data" flow (Settings). */
export async function clearAllStores(): Promise<void> {
  const db = await getDB()
  await Promise.all([
    db.clear('settings'),
    db.clear('books'),
    db.clear('chapters'),
    db.clear('files'),
    db.clear('audioCache'),
    db.clear('audioSegments'),
    db.clear('bookAudio'),
  ])
}

/** Clear every store — test-only isolation helper. Call after `_resetDBForTests`. */
export async function _clearDBForTests(): Promise<void> {
  await clearAllStores()
}
