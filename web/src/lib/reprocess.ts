/**
 * Reprocess support (M6 T7): re-parse a book's original uploaded file to recover
 * pristine paragraphs before re-applying transforms. Keeps existing chapter IDs
 * stable (matched by index) so reader position — which is index-based — and any
 * future per-chapter references remain valid. See `docs/prds/M6-ai-transforms.md`.
 *
 * The original uploaded file is the source of truth (gotcha: the parser is
 * deterministic for a given file, so the re-parsed chapter structure matches the
 * stored chapters; if a re-parse ever yields more chapters, the extras get fresh
 * IDs, and a shorter re-parse leaves stale tail chapters that a future cleanup
 * pass can sweep — neither happens in practice today).
 */

import type { BookId, Chapter } from '../types'
import { newChapterId } from '../types'
import { deleteChaptersByIds, getBookFile, getChaptersByBook } from './db'
import { parseInWorker } from './parse/client'

export class OriginalUnavailableError extends Error {
  override readonly name = 'OriginalUnavailableError'
  constructor() {
    super('Original file is no longer available — re-upload the book to reprocess.')
  }
}

/**
 * Re-parse the stored original file for `bookId` into fresh `Chapter[]`,
 * preserving existing chapter IDs by index. Throws {@link OriginalUnavailableError}
 * when the raw blob has been evicted from storage.
 */
export async function reparseChapters(bookId: BookId): Promise<Chapter[]> {
  const stored = await getBookFile(bookId)
  if (!stored) throw new OriginalUnavailableError()
  const file = new File([stored.blob], stored.name, { type: stored.type })
  const result = await parseInWorker(file)
  const existing = await getChaptersByBook(bookId)
  const mapped = result.chapters.map((parsed, index) => {
    const ex = existing[index]
    return {
      id: ex?.id ?? newChapterId(),
      bookId,
      index,
      title: parsed.title,
      paragraphs: parsed.paragraphs,
    }
  })
  // Sweep stale tail chapters if the re-parse yielded fewer than before.
  if (mapped.length < existing.length) {
    const staleIds = existing.slice(mapped.length).map((c) => c.id)
    await deleteChaptersByIds(staleIds)
  }
  return mapped
}
