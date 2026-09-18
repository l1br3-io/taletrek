package dev.l1br3.taletrek.playback

import dev.l1br3.taletrek.ffi.FfiPlayerAction
import dev.l1br3.taletrek.ffi.FfiPlayerEvent
import dev.l1br3.taletrek.ffi.FfiPosition
import dev.l1br3.taletrek.ffi.FfiStateSnapshot
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The only place Media3 and the kernel meet — the desktop's playback
 * controller discipline, ported to callbacks (the desktop pumps a queue;
 * Android's listener pushes instead). The platform contract verbatim:
 * audio time arrives here as platform callbacks, sequencing decisions
 * leave here as kernel events, and this class contains no next/prev/boundary
 * logic of its own — every decision is a [KernelPlayer] transition.
 *
 * # The pending-load window (the same-key race closure)
 *
 * Duplicate-text paragraphs share segment keys, so a stale completion for
 * the paragraph the player *was* on can arrive right after the machine
 * re-loaded identical content — the kernel's key check cannot tell it
 * apart from the real drain. The closure is the pending window: while a
 * load is outstanding, completions are dropped; the platform's *ready*
 * callback (emitted once the new playhead is armed) ends the window, FIFO
 * after any pre-load completion because both arrive on the main thread.
 * A completion observed after the ack can only belong to the new load.
 */
class PlayerBridge(
    private val kernel: KernelPlayer,
    private val segments: SegmentSource,
    private val cache: SegmentCache,
    private val port: AudioPort,
    private val scope: CoroutineScope,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val keepWaiting: () -> Boolean = { true },
    private val onBuffering: ((Boolean) -> Unit)? = null,
    private val onStalled: (() -> Unit)? = null,
    private val onPositionChanged: ((FfiPosition?) -> Unit)? = null,
    private val onSnapshotChanged: ((FfiStateSnapshot) -> Unit)? = null,
) {
    /** The key of the outstanding load, until its ready/failure report. */
    private var pendingKey: String? = null

    /** The key the platform was last told to load (drains are tagged with it). */
    private var lastLoadedKey: String? = null

    /** The last position reported to [onPositionChanged] (write dedup). */
    private var lastReportedPosition: FfiPosition? = null

    private var loadJob: Job? = null

    /** The last ordered (key, offset) — what a resume retries. */
    private var lastRequest: Pair<String, Double>? = null

    /** Whether a buffering signal is currently outstanding (edge-triggered). */
    private var waiting = false

    // --- user transport (buttons, notification, media keys) ------------

    fun userPlay() = dispatch(FfiPlayerEvent.Play)

    fun userPause() = dispatch(FfiPlayerEvent.Pause)

    fun userNextParagraph() = dispatch(FfiPlayerEvent.NextParagraph)

    fun userPrevParagraph() = dispatch(FfiPlayerEvent.PrevParagraph)

    fun userNextChapter() = dispatch(FfiPlayerEvent.NextChapter)

    fun userPrevChapter() = dispatch(FfiPlayerEvent.PrevChapter)

    fun userSeekToParagraph(
        chapter: UInt,
        index: UInt,
    ) = dispatch(
        FfiPlayerEvent.SeekToParagraph(
            dev.l1br3.taletrek.ffi
                .FfiParagraphPos(chapter, index),
        ),
    )

    /** One transition through the machine, then execute its order. */
    private fun dispatch(event: FfiPlayerEvent) {
        execute(kernel.tick(event))
        reportPosition()
        onSnapshotChanged?.invoke(kernel.snapshot())
    }

    /**
     * The save cadence (the desktop's paragraph-gate, mobile-shaped):
     * report whenever the kernel's durable position *changes* — which
     * happens only on transport events (the kernel's offset moves on
     * scrubs and seeks, not audio time), so writes ride paragraph
     * advances, pauses, and the restore, never a frame loop.
     */
    private fun reportPosition() {
        val listener = onPositionChanged ?: return
        val pos = kernel.position()
        if (pos == lastReportedPosition) return
        lastReportedPosition = pos
        listener(pos)
    }

    // --- platform callbacks (the exo adapter calls these) ---------------

    /** The new playhead is armed — the pending window closes. */
    fun onReady() {
        pendingKey = null
    }

    /** The platform finished the current item (drain, tagged with the last load). */
    fun onEnded() {
        if (pendingKey != null) return // pre-load stale — dropped
        val key = lastLoadedKey ?: return
        dispatch(FfiPlayerEvent.SegmentDrained(key))
    }

    /** The platform could not load or decode the current item. */
    fun onError(error: Throwable) {
        val key = pendingKey ?: lastLoadedKey ?: return
        pendingKey = null
        dispatch(FfiPlayerEvent.SegmentFailed(key, error.message ?: "playback error"))
    }

    // --- action execution ------------------------------------------------

    private fun execute(action: FfiPlayerAction) {
        when (action) {
            is FfiPlayerAction.LoadSegment -> beginLoad(action.key, action.offset)
            FfiPlayerAction.Stop -> {
                loadJob?.cancel()
                pendingKey = null
                clearWaiting()
                port.stopOutput()
                cache.clear()
            }
            FfiPlayerAction.None -> Unit
        }
    }

    private fun beginLoad(
        key: String,
        offset: Double,
    ) {
        loadJob?.cancel()
        pendingKey = key
        lastRequest = key to offset
        loadJob =
            scope.launch {
                while (true) {
                    val fetch = withContext(ioDispatcher) { segments.segment(key) }
                    when (fetch) {
                        is SegmentFetch.Bytes -> {
                            if (pendingKey != key) return@launch // superseded mid-flight
                            val file = withContext(ioDispatcher) { cache.write(key, fetch.data) }
                            if (pendingKey != key) return@launch
                            lastLoadedKey = key
                            clearWaiting()
                            port.load(file, key, (offset * 1000).toLong())
                            return@launch
                        }
                        SegmentFetch.Absent -> {
                            // A missing segment is the platform's failure to
                            // load — the kernel's skip path, not ours.
                            clearWaiting()
                            dispatch(FfiPlayerEvent.SegmentFailed(key, "segment missing from bundle"))
                            return@launch
                        }
                        SegmentFetch.NotYet -> {
                            if (pendingKey != key) return@launch // superseded mid-flight
                            if (!keepWaiting()) {
                                // The segment is expected but no job will
                                // land it — surface the stall, never a skip.
                                pendingKey = null
                                clearWaiting()
                                onStalled?.invoke()
                                return@launch
                            }
                            markWaiting()
                            delay(NOT_YET_RETRY_MS)
                        }
                    }
                }
            }
    }

    private fun markWaiting() {
        if (!waiting) {
            waiting = true
            onBuffering?.invoke(true)
        }
    }

    private fun clearWaiting() {
        if (waiting) {
            waiting = false
            onBuffering?.invoke(false)
        }
    }

    /** Re-run the last ordered load — the resume affordance's retry. */
    fun retry() {
        val (key, offset) = lastRequest ?: return
        beginLoad(key, offset)
    }

    // --- observation -----------------------------------------------------

    fun snapshot() = kernel.snapshot()

    fun position() = kernel.position()

    fun release() {
        loadJob?.cancel()
        clearWaiting()
        port.stopOutput()
        cache.clear()
        kernel.close()
    }

    private companion object {
        const val NOT_YET_RETRY_MS = 400L
    }
}
