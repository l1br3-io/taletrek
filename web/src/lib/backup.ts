/**
 * Backup & restore — full data portability across devices.
 *
 * Exports every IndexedDB store **except** `audioCache` (which is regenerable
 * from text+voice via content-addressed keys, and bounded only by the 500 MB
 * soft cap — shipping it would balloon backup files for a transient benefit).
 * The `files` store holds binary ebook `Blob`s; those are base64-encoded into
 * the JSON manifest.
 *
 * Import is non-destructive: books whose ID already exists locally are skipped
 * (chapters/files for a skipped book are skipped too — they're meaningless
 * without the parent and would create duplicate chapter IDs). Settings are
 * overwritten by default.
 */

import type { Book, BookFile, Chapter } from '../types'
import { getDB } from './db'

/** Backup manifest version — bump on breaking format changes. */
export const BACKUP_VERSION = 1

/** Shape of a settings entry inside the backup (settings store has string keys). */
export interface BackupSetting {
  key: string
  value: unknown
}

/** A `BookFile` with its blob encoded as base64 for JSON transport. */
export interface BackupFileRecord {
  bookId: string
  name: string
  type: string
  size: number
  blobBase64: string
}

export interface BackupManifest {
  app: 'taletrek'
  version: typeof BACKUP_VERSION
  /** IndexedDB schema version at export time (for future migrations). */
  dbVersion: number
  exportedAt: number
  settings: BackupSetting[]
  books: Book[]
  chapters: Chapter[]
  files: BackupFileRecord[]
}

export class CorruptBackupError extends Error {
  override readonly name = 'CorruptBackupError'
  constructor(reason: string) {
    super(`Backup file is not valid: ${reason}`)
  }
}

export class BackupTooLargeError extends Error {
  override readonly name = 'BackupTooLargeError'
  constructor() {
    super("Import would exceed this device's storage quota. Free up space and try again.")
  }
}

export interface ImportReport {
  booksImported: number
  booksSkipped: number
  chaptersImported: number
  filesImported: number
  settingsApplied: boolean
}

export interface ImportOptions {
  /** Overwrite local settings with the backup's. Default: true. */
  includeSettings?: boolean
}

// ---------------------------------------------------------------------------
// Base64 helpers — chunked to avoid call-stack overflow on large blobs.
// ---------------------------------------------------------------------------

const BASE64_CHUNK = 0x8000 // 32 KiB per `apply` call (safe under V8's stack limit).

/** Encode a `Blob` to a base64 string without blowing the stack. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

/** Decode a base64 string back into a `Blob`, preserving the original MIME type. */
export function base64ToBlob(b64: string, type: string): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/** Parse and validate a backup JSON string. Throws `CorruptBackupError` on any failure. */
export function parseManifest(json: string): BackupManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new CorruptBackupError('file is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CorruptBackupError('root is not an object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.app !== 'taletrek') {
    throw new CorruptBackupError('not a TaleTrek backup')
  }
  if (obj.version !== BACKUP_VERSION) {
    throw new CorruptBackupError(
      `unsupported backup version ${String(obj.version)} (expected ${BACKUP_VERSION})`,
    )
  }
  for (const field of ['settings', 'books', 'chapters', 'files'] as const) {
    if (!Array.isArray(obj[field])) {
      throw new CorruptBackupError(`missing or non-array field "${field}"`)
    }
  }
  return obj as unknown as BackupManifest
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Build a backup of all user data (settings + books + chapters + files).
 * Returns a JSON `Blob` ready for download. The `audioCache` store is excluded
 * — it regenerates as you read on the new device.
 */
export async function exportBackup(): Promise<Blob> {
  const db = await getDB()
  const [settingsEntries, books, chapters, fileRecords] = await Promise.all([
    db.getAll('settings'),
    db.getAll('books'),
    db.getAll('chapters'),
    db.getAll('files'),
  ])

  // `settings` store has out-of-line keys — `getAll` returns values only; we
  // also need the keys to reconstruct on import.
  const settings: BackupSetting[] = []
  const settingsKeys = await db.getAllKeys('settings')
  for (let i = 0; i < settingsKeys.length; i++) {
    settings.push({ key: String(settingsKeys[i]), value: settingsEntries[i] })
  }

  const files: BackupFileRecord[] = await Promise.all(
    (fileRecords as BookFile[]).map(async (f) => ({
      bookId: f.bookId,
      name: f.name,
      type: f.type,
      size: f.size,
      blobBase64: await blobToBase64(f.blob),
    })),
  )

  const manifest: BackupManifest = {
    app: 'taletrek',
    version: BACKUP_VERSION,
    dbVersion: 3,
    exportedAt: Date.now(),
    settings,
    books: books as Book[],
    chapters: chapters as Chapter[],
    files,
  }
  return new Blob([JSON.stringify(manifest)], { type: 'application/json' })
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Import a backup `Blob` into the local database.
 *
 * Runs in a single read/write transaction across all four stores so a failure
 * (e.g. quota mid-import) rolls back cleanly. Books whose ID already exists
 * locally are skipped, along with their chapters and file.
 */
export async function importBackup(blob: Blob, opts: ImportOptions = {}): Promise<ImportReport> {
  const includeSettings = opts.includeSettings ?? true
  const json = await blob.text()
  const manifest = parseManifest(json)

  const db = await getDB()
  const tx = db.transaction(['settings', 'books', 'chapters', 'files'], 'readwrite')

  const report: ImportReport = {
    booksImported: 0,
    booksSkipped: 0,
    chaptersImported: 0,
    filesImported: 0,
    settingsApplied: false,
  }

  try {
    if (includeSettings) {
      for (const { key, value } of manifest.settings) {
        await tx.objectStore('settings').put(value, key)
      }
      report.settingsApplied = true
    }

    for (const book of manifest.books) {
      const existing = await tx.objectStore('books').get(book.id)
      if (existing) {
        report.booksSkipped++
        continue
      }
      await tx.objectStore('books').put(book)
      report.booksImported++

      for (const chapter of manifest.chapters) {
        if (chapter.bookId !== book.id) continue
        await tx.objectStore('chapters').put(chapter)
        report.chaptersImported++
      }

      for (const file of manifest.files) {
        if (file.bookId !== book.id) continue
        const record: BookFile = {
          bookId: book.id,
          blob: base64ToBlob(file.blobBase64, file.type),
          name: file.name,
          type: file.type,
          size: file.size,
        }
        await tx.objectStore('files').put(record)
        report.filesImported++
      }
    }

    await tx.done
  } catch (err) {
    // tx.done rejects; the transaction auto-aborts so partial writes are rolled back.
    if (isQuotaExceededError(err)) throw new BackupTooLargeError()
    throw err
  }

  return report
}

/** Best-effort detection of quota-exceeded across browsers (mirrors db.ts). */
export function isQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  )
}
