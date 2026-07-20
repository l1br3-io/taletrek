import { getBookAudio } from '../book-audio'
import { getAllBooks, putBook } from '../db'

/**
 * Boot-time reconciliation for interrupted upload/synth jobs.
 *
 * A book with `uploading === true` on app boot means the previous session's
 * `uploadManager.runJob` never reached `clearUploadingFlag` — most likely
 * because the tab was closed or evicted mid-synth (wake lock couldn't save it).
 *
 * Recovery rule (revised 2026-07-19, superseding ADR-0009's original
 * cascade-delete contract):
 *
 * - If the book has audio (`getBookAudio` returns a record): synth actually
 *   completed but the flag just got stranded → clear the flag, keep the book.
 *   Covers interrupted re-synths where the user's old audio is still valid.
 * - If the book has no audio: an `initial`-mode job was interrupted before
 *   any m4a landed → **convert to paused** (`uploading = false`, leave the
 *   `uploadJob` that `runJob` persists from the start). The M8 content-addressed
 *   audioCache entries survive (keyed by content hash; only deleted if the
 *   book itself is cascade-deleted), so resume fast-forwards through whatever
 *   paragraphs already synthesized. The library shows a Resume button.
 *   - Legacy edge: a stuck book with no `uploadJob` (started under pre-2026-07
 *     code) — just clear the flag and leave it as a normal card; user hits
 *     "Synthesize" from the menu. Strictly better than cascade-deleting.
 *
 * Why the change: the original contract cascade-deleted interrupted initial
 * uploads on the premise that the user had "no investment" in a half-baked
 * upload. In practice the user invests minutes of waiting + the synth work
 * already landed in the audioCache — losing all of it on iOS tab eviction was
 * the single most painful failure mode in real use. The pluggable-engine work
 * (ADR-0010) made pausable synthesis first-class; extending the same machinery
 * to true interruptions (not just explicit pauses) closes the gap.
 *
 * Idempotent and safe to call multiple times. Silent — logs only.
 */
export interface SweepReport {
  clearedFlags: number
  convertedToPaused: number
  transformedToPaused: number
}

export async function reconcileInterruptedUploads(): Promise<SweepReport> {
  const books = await getAllBooks()
  const stuck = books.filter((b) => b.uploading === true)
  if (stuck.length === 0) return { clearedFlags: 0, convertedToPaused: 0, transformedToPaused: 0 }

  let clearedFlags = 0
  let convertedToPaused = 0

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
        // No audio → interrupted initial-mode job. Convert to paused so the
        // library shows Resume. `uploadJob` should already be persisted (runJob
        // writes it from the start); the legacy edge handles older books.
        delete book.uploading
        book.updatedAt = Date.now()
        await putBook(book).catch((error) => {
          console.info('[taletrek] boot-sweep: could not convert', book.id, error)
        })
        convertedToPaused += 1
      }
    }),
  )

  if (clearedFlags || convertedToPaused) {
    console.info('[taletrek] boot-sweep:', { clearedFlags, convertedToPaused })
  }
  return { clearedFlags, convertedToPaused, transformedToPaused: 0 }
}

/**
 * Boot-time reconciliation for interrupted whole-book AI transforms (M13 /
 * ADR-0012). Mirrors {@link reconcileInterruptedUploads}'s recovery rule:
 *
 * A book with `transforming === true` on app boot means the previous session's
 * `bookTransformManager.runLoop` never reached `clearTransformingFlag` — most
 * likely because the tab was closed or evicted mid-chunk.
 *
 * Recovery rule (mirrors ADR-0009 revised rule, never cascade-deletes):
 * - If `book.transformJob` exists: **convert to paused** (delete `transforming`,
 *   keep `transformJob`). Already-committed chapters survive; resume is
 *   user-initiated from the library.
 * - Legacy edge (no `transformJob`, from pre-M13 code): just clear
 *   `transforming` and leave the book alone.
 *
 * **Explicit pauses are invisible to this sweep** — pause sets
 * `transforming = false` (gotcha #24 parallel), so only true interruptions
 * (tab close, crash, OS kill) are reconciled here. Never auto-resume.
 */
export async function reconcileInterruptedTransforms(): Promise<
  Pick<SweepReport, 'transformedToPaused'>
> {
  const books = await getAllBooks()
  const stuck = books.filter((b) => b.transforming === true)
  if (stuck.length === 0) return { transformedToPaused: 0 }

  let transformedToPaused = 0

  await Promise.all(
    stuck.map(async (book) => {
      delete book.transforming
      book.updatedAt = Date.now()
      await putBook(book).catch((error) => {
        console.info('[taletrek] boot-sweep: could not transform-clear', book.id, error)
      })
      // If transformJob exists, the book surfaces as Paused in the library and
      // user can Resume. If not (legacy edge), the book is just a normal card.
      transformedToPaused += 1
    }),
  )

  if (transformedToPaused > 0) {
    console.info('[taletrek] boot-sweep: transforms converted to paused:', transformedToPaused)
  }
  return { transformedToPaused }
}
