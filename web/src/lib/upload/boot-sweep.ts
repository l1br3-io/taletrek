import { getBookAudio } from '../book-audio'
import { deleteBookCascade, getAllBooks, putBook } from '../db'

/**
 * Boot-time reconciliation for interrupted upload/synth jobs.
 *
 * A book with `uploading === true` on app boot means the previous session's
 * `uploadManager.runJob` never reached `clearUploadingFlag` — most likely
 * because the tab was closed or evicted mid-synth (wake lock couldn't save it).
 *
 * Recovery rule per ADR-0009:
 * - If the book has audio (`getBookAudio` returns a record): synth actually
 *   completed but the flag just got stranded → clear the flag, keep the book.
 *   Covers interrupted re-synths where the user's old audio is still valid.
 * - If the book has no audio: an `initial`-mode job was interrupted before
 *   any audio landed → cascade-delete to match the existing failure contract
 *   in `manager.ts` (initial failures delete the book; the user has no
 *   investment in a half-baked upload). The original file is gone with it,
 *   which is correct — the user hadn't successfully used it yet.
 *
 * Idempotent and safe to call multiple times. Silent — logs only.
 */
export interface SweepReport {
  clearedFlags: number
  deletedIncomplete: number
}

export async function reconcileInterruptedUploads(): Promise<SweepReport> {
  const books = await getAllBooks()
  const stuck = books.filter((b) => b.uploading === true)
  if (stuck.length === 0) return { clearedFlags: 0, deletedIncomplete: 0 }

  let clearedFlags = 0
  let deletedIncomplete = 0

  await Promise.all(
    stuck.map(async (book) => {
      const audio = await getBookAudio(book.id).catch(() => undefined)
      if (audio) {
        // Audio exists → synth finished but flag wasn't cleared. Keep book,
        // clear the flag.
        delete book.uploading
        book.updatedAt = Date.now()
        await putBook(book).catch((error) => {
          console.info('[taletrek] boot-sweep: could not clear flag for', book.id, error)
        })
        clearedFlags += 1
      } else {
        // No audio → initial-mode job was interrupted mid-synth. Cascade-delete
        // to match the fresh-upload failure contract.
        await deleteBookCascade(book.id).catch((error) => {
          console.info('[taletrek] boot-sweep: could not delete', book.id, error)
        })
        deletedIncomplete += 1
      }
    }),
  )

  if (clearedFlags || deletedIncomplete) {
    console.info('[taletrek] boot-sweep:', { clearedFlags, deletedIncomplete })
  }
  return { clearedFlags, deletedIncomplete }
}
