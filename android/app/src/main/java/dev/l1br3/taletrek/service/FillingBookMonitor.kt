package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.data.BookShelf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/** The one book a fill targets — the monitor's whole public identity. */
data class FillingBook(
    val path: String,
    val bookId: String,
    val phase: FillPhase,
)

/** How the fill stands for its book. */
sealed interface FillPhase {
    /** A live progressive job is filling this book right now. */
    data object Live : FillPhase

    /** The job ended Cancelled/Failed; marker + source survive for a
     *  one-tap manual resume. */
    data class Paused(
        val reason: PendingTerminal,
    ) : FillPhase
}

/** The per-book routing gate: a closure asks "may I wait on / steer the
 *  live fill for *this* book?" — paused fills never route (nothing to
 *  wait for, nothing to steer). */
fun FillingBook?.isLiveFor(path: String?): Boolean {
    if (this == null || phase != FillPhase.Live) return false
    return this.path == path
}

/**
 * THE fill authority — the only process-wide decider of "is this book
 * filling?" (spec: no other fill decision may sample process state).
 * One reactive derivation over three inputs: the pending marker (with
 * its shelf snapshot + terminal reason), the shelf scan, and the
 * service's job slot. A book is filling iff the live-or-paused job
 * targets *it* — resolved by snapshot-diff: the single text-only
 * bundle on the shelf that appeared since the marker was saved.
 *
 * While a job runs and the candidate is unresolved (parse hasn't
 * written the text bundle yet), the monitor drives shelf rescans on a
 * ticker — arming works even when no library screen is composed. The
 * unspent-marker-no-live-job window (process death, resume pending)
 * derives null: the relaunch auto-resume owns that transient.
 *
 * Constructed directly in tests; production wiring goes through
 * [FillingBookMonitor.start] from the activity (mirroring
 * `SynthService.active`'s process-wide shape — reads before start are
 * inert nulls).
 */
class FillingBookMonitor internal constructor(
    private val store: PendingJobStore,
    private val shelf: Flow<List<BookShelf>>,
    private val active: StateFlow<SynthUiState?>,
    private val sourceAlive: (String) -> Boolean,
    private val rescan: suspend () -> Unit,
    private val scope: CoroutineScope,
) {
    private val _filling = MutableStateFlow<FillingBook?>(null)

    /** The reactive answer — one book, or null. */
    val filling: StateFlow<FillingBook?> = _filling.asStateFlow()

    private var ticker: Job? = null

    /** Begin observing; idempotent. */
    fun start() {
        scope.launch {
            combine(active, shelf, store.revisions) { state, books, _ -> state to books }
                .collect { (state, books) -> rederive(state, books) }
        }
    }

    private fun rederive(
        state: SynthUiState?,
        books: List<BookShelf>,
    ) {
        val marker = store.load()
        val derived = derive(marker, books, state)
        _filling.value = derived
        ticker?.cancel()
        if (state?.isRunningPhase == true && marker != null && derived == null) {
            ticker =
                scope.launch {
                    var attempts = 0
                    // Bounded: parse writes the text bundle within
                    // seconds — a job that hasn't produced a candidate
                    // after this many scans never will (the library's
                    // own evented rescans keep feeding the shelf flow).
                    while (
                        isActive &&
                        attempts < MAX_RESCAN_ATTEMPTS &&
                        active.value?.isRunningPhase == true &&
                        _filling.value == null &&
                        store.load() != null
                    ) {
                        attempts++
                        rescan()
                        delay(RESCAN_INTERVAL_MS)
                    }
                }
        }
    }

    private fun derive(
        marker: PendingJobStore.PendingJob?,
        books: List<BookShelf>,
        state: SynthUiState?,
    ): FillingBook? {
        if (marker == null) return null
        val candidate =
            books
                .filter { !it.audioPresent && it.path !in marker.preExistingBookPaths }
                .singleOrNull() ?: return null
        return when {
            state?.isRunningPhase == true -> FillingBook(candidate.path, candidate.bookId, FillPhase.Live)
            marker.terminalReason != null && sourceAlive(marker.request.sourcePath) ->
                FillingBook(candidate.path, candidate.bookId, FillPhase.Paused(marker.terminalReason))
            else -> null
        }
    }

    companion object {
        /** Rescan cadence while a job runs unresolved — parse writes the
         *  text bundle within seconds; the ticker bridges the gap. */
        const val RESCAN_INTERVAL_MS = 2_000L

        /** The bound: ~5 minutes of unresolved-running, then the ticker
         *  yields to the evented shelf flow. */
        const val MAX_RESCAN_ATTEMPTS = 150

        private val inert = MutableStateFlow<FillingBook?>(null)

        /** The process-wide answer — inert (null) until [start] wires it. */
        val filling: StateFlow<FillingBook?> get() = Companion.started?.filling ?: inert

        @Volatile
        private var started: FillingBookMonitor? = null

        private val monitorScope = CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)

        /** Wire the process-wide monitor (idempotent — re-wiring on
         *  activity recreate swaps the shelf source, keeping the last
         *  answer until the next derivation). */
        fun start(
            store: PendingJobStore,
            shelf: Flow<List<BookShelf>>,
            rescan: suspend () -> Unit,
        ): FillingBookMonitor {
            val monitor =
                FillingBookMonitor(
                    store = store,
                    shelf = shelf,
                    active = SynthService.active,
                    sourceAlive = { path -> File(path).isFile },
                    rescan = rescan,
                    scope = monitorScope,
                )
            monitor.start()
            started = monitor
            return monitor
        }
    }
}
