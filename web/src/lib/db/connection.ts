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
 * Historical (ADR-0007) ciphertext envelope shape. The `secureKeyring` store
 * survives in the schema for existing databases; nothing reads it since the
 * native pivot (ADR-0015) removed the biometric keyring.
 */
export interface AesEnvelope {
  iv: Uint8Array
  ciphertext: Uint8Array
}

/**
 * TaleTrek IndexedDB schema.
 *
 * v1 (M0): `settings` store only.
 * v2 (M1): adds `books`, `chapters`, and `files` stores for the ingest pipeline.
 * v3 (M8): adds `audioCache` store for the persistent TTS audio cache.
 * v4 (M9): adds `audioSegments` store for mobile fMP4 streaming segments.
 * v5 (M9 Path A): adds `bookAudio` store for pre-baked M4A blobs.
 * v6 (M6.1): adds `secureKeyring` store for biometric-cached API keys
 *   (ADR-0007). Single record at key `'current'`. Contains only ciphertext +
 *   salts + WebAuthn credential id — never plaintext.
 */
export interface SecureKeyringRecord {
  /** Fixed key — one enrollment at a time. */
  key: 'current'
  /** PRF salt fed to {@link deriveKey} to recover the KEK. */
  salt: Uint8Array
  /** WebAuthn credential id (base64url) from {@link enrollPrf}. */
  credentialId: string
  /** DEK wrapped with the KEK derived from `(credential, salt)`. */
  wrappedDek: AesEnvelope
  /** API-key blob (`{ [providerId]: string }` UTF-8 JSON) encrypted with the DEK. */
  encryptedKeys: AesEnvelope
  /** Schema version of this record, for future migrations. */
  version: number
  createdAt: number
}

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
  secureKeyring: {
    key: 'current'
    value: SecureKeyringRecord
  }
}

const DB_NAME = 'taletrek'
const DB_VERSION = 6

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
        // v6 (M6.1): secureKeyring store for biometric-cached API keys (ADR-0007)
        if (oldVersion < 6) {
          if (!db.objectStoreNames.contains('secureKeyring')) {
            db.createObjectStore('secureKeyring', { keyPath: 'key' })
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
  const present = ALL_STORE_NAMES.filter((s) => db.objectStoreNames.contains(s))
  await Promise.all(present.map((s) => db.clear(s as (typeof ALL_STORE_NAMES)[number])))
}

/**
 * Delete every `audioSegments` entry (the historical M9 fMP4 cache). Returns
 * the count removed. Kept for the Settings clear-cache flow + legacy data.
 */
export async function clearSegmentCache(): Promise<number> {
  const db = await getDB()
  const count = await db.count('audioSegments')
  await db.clear('audioSegments')
  return count
}

/** All store names the schema knows about — `clearAllStores` skips any that a
 * stale DB is missing (see {@link deleteBookCascade}). */
const ALL_STORE_NAMES = [
  'settings',
  'books',
  'chapters',
  'files',
  'audioCache',
  'audioSegments',
  'bookAudio',
  'secureKeyring',
] as const

/** Clear every store — test-only isolation helper. Call after `_resetDBForTests`. */
export async function _clearDBForTests(): Promise<void> {
  await clearAllStores()
}
