package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.data.BooksRepo
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

/**
 * Delete-a-book policy: removal takes everything working on the book
 * down with it. The plain repo delete (bundle file + position) is the
 * last step, not the whole story — a filling book's delete must first
 *
 * 1. **cancel the live job** and await its terminal state: the
 *    progressive drain seals the finished bundle atomically into
 *    `books/`, so deleting the file while the job runs resurrects the
 *    book moments later;
 * 2. **spend the pending marker and its staged source copy**: an
 *    unspent marker auto-resumes on relaunch (and a stamped one offers
 *    manual resume) — either path re-converts a book the user deleted;
 * 3. **pause playback** of that book (a deleted book shouldn't keep
 *    narrating from the segment store).
 *
 * A foreign book's job is never touched (the single job slot belongs
 * to whichever book [FillingBookMonitor] names). The monitor's
 * identity is path-based: during the brief parse-before-landing window
 * a filling book isn't on the shelf yet, so no row exists to delete —
 * the one unattributable case (a re-import over an existing row) keeps
 * today's plain-delete behavior.
 *
 * The terminal stamping race is benign by construction: the activity's
 * terminal collector stamps `load() ?: return` — a marker already
 * spent by this flow is invisible to it, in either interleaving.
 */
class BookRemoval(
    private val repo: BooksRepo,
    private val pendingStore: PendingJobStore,
    private val filling: StateFlow<FillingBook?>,
    private val active: StateFlow<SynthUiState?>,
    private val requestCancel: () -> Unit,
    private val pausePlayback: (path: String) -> Unit,
) {
    /** Remove [book] and everything processing it; safe for any shelf row. */
    suspend fun remove(book: BookShelf) {
        pausePlayback(book.path)
        if (filling.value?.path == book.path) {
            if (filling.value?.phase == FillPhase.Live && active.value?.isRunningPhase == true) {
                requestCancel()
                // Bounded: cancel lands at a chunk boundary (the poll is
                // 150 ms); a job that never terminals must not wedge the
                // delete — the marker spend below still prevents the
                // relaunch resurrection.
                withTimeoutOrNull(CANCEL_LANDS_MS) {
                    active.first { it == null || !it.isRunningPhase }
                }
            }
            pendingStore.load()?.let { marker ->
                runCatching { File(marker.request.sourcePath).delete() }
            }
            pendingStore.clear()
        }
        repo.delete(book)
    }

    companion object {
        /** How long a delete waits for the cancelled job to land. */
        const val CANCEL_LANDS_MS = 10_000L
    }
}
