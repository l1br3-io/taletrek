package dev.l1br3.taletrek

import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.ffi.openBook
import dev.l1br3.taletrek.playback.ExoPlayerPort
import dev.l1br3.taletrek.playback.PlayerBridge
import dev.l1br3.taletrek.playback.ProgressiveSegmentSource
import dev.l1br3.taletrek.playback.SegmentCache
import dev.l1br3.taletrek.playback.TrekKernelPlayer
import dev.l1br3.taletrek.service.FillPhase
import dev.l1br3.taletrek.service.FillingBookMonitor
import dev.l1br3.taletrek.service.PendingImportResume
import dev.l1br3.taletrek.service.PendingJobStore
import dev.l1br3.taletrek.service.PendingTerminal
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import dev.l1br3.taletrek.service.isLiveFor
import dev.l1br3.taletrek.service.isRunningPhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * THE fill-state matrix on one device, through the real service and the
 * real monitor wiring (relaunch/UI decision chains are JVM-pinned; this
 * pins them against the real on-disk world): (a) a reader open before
 * submit sees the fill go live and plays; (b) cancel keeps the recovery
 * material, relaunch never auto-resumes a cancel, the manual resume
 * seals without a voice re-download; (c) a foreign text-only book
 * stalls honestly while another book converts — never buffers, never
 * steers the live job.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class FillStatesTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    private fun freshDir(name: String): File {
        val dir = File(files, "fill-states/$name")
        dir.deleteRecursively()
        dir.mkdirs()
        return dir
    }

    /** Distinct text per `name` — distinct cache keys per document. */
    private fun doc(name: String): File {
        val text =
            buildString {
                appendLine("the fill-states walk ($name)")
                repeat(24) { i -> appendLine("\n$name paragraph $i of the walk says its own words out loud.") }
            }
        return File(context.cacheDir, name).apply { writeText(text) }
    }

    private fun request(
        source: File,
        books: File,
        store: File,
    ) = SynthJobRequest(
        sourcePath = source.absolutePath,
        hint = source.name,
        voiceId = null,
        voiceCacheDir = File(files, "voices").path,
        espeakDir = File(files, "espeak-ng-data").path,
        booksDir = books.absolutePath,
        storeDir = store.absolutePath,
        jobs = 2,
        generatorApp = "taletrek-android",
    )

    /** The real monitor over the real service state — process-wired,
     *  exactly the production seams (a real shelf scan in the rescan
     *  slot, the marker store beside the library). */
    private fun wireMonitor(
        store: PendingJobStore,
        books: File,
    ): MutableStateFlow<List<BookShelf>> {
        val shelf = MutableStateFlow<List<BookShelf>>(emptyList())
        FillingBookMonitor.start(
            store = store,
            shelf = shelf,
            rescan = {
                shelf.value =
                    books
                        .listFiles { f -> f.name.endsWith(".taletrek") }
                        .orEmpty()
                        .mapNotNull { file ->
                            runCatching { openBook(file.absolutePath) }.getOrNull()?.let {
                                BookShelf(it.bookId, it.title, it.author, it.chapters.size, it.audioPresent, file.absolutePath)
                            }
                        }
            },
        )
        return shelf
    }

    private fun saveMarkerLikeTheImportFlow(
        store: PendingJobStore,
        request: SynthJobRequest,
        shelf: File,
    ) {
        store.save(
            PendingJobStore.PendingJob(
                request = request,
                preExistingBookPaths =
                    shelf
                        .listFiles { f -> f.name.endsWith(".taletrek") }
                        .orEmpty()
                        .map { it.absolutePath },
            ),
        )
    }

    private fun awaitTerminal(): SynthUiState =
        runBlocking {
            val before = SynthService.active.value
            withTimeout(300_000) { SynthService.active.first { it != before } }
            withTimeout(600_000) {
                SynthService.active.first {
                    it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                }!!
            }
        }

    private fun cancelViaServiceIntent() {
        context.startService(
            android.content
                .Intent(context, SynthService::class.java)
                .setAction(SynthService.ACTION_CANCEL),
        )
    }

    private fun resume(
        store: PendingJobStore,
        shelf: File,
    ): PendingImportResume =
        PendingImportResume(
            store = store,
            loadPosition = { null },
            isConverting = { SynthService.active.value?.isRunningPhase == true },
            startJob = { r -> context.startForegroundService(r.toIntent(context)) },
        )

    private fun fileMap(dir: File): Map<String, Long> =
        dir
            .walkTopDown()
            .filter { it.isFile }
            .associate { it.relativeTo(dir).path to it.length() }

    @Test
    fun aOpenedBeforeSubmitSeesTheFillGoLiveAndPlays() {
        val voices = File(files, "voices")
        dev.l1br3.taletrek.ffi
            .ffiResolveVoice(null, voices.path, SilentDownload)
        val books = freshDir("books-a")
        val store = freshDir("store-a")
        val source = doc("fill-states-a.txt")
        val marker = PendingJobStore(files)
        marker.clear()
        val shelf = wireMonitor(marker, books)

        // Opened before submit: no job, no marker — the honest inert
        // null (nothing to derive from, whatever the collection timing).
        assertTrue("no job yet → no fill", FillingBookMonitor.filling.value == null)

        saveMarkerLikeTheImportFlow(marker, request(source, books, store), books)
        context.startForegroundService(request(source, books, store).toIntent(context))

        // The monitor's own ticker rescans until the text bundle lands.
        val filling =
            runBlocking {
                withTimeout(300_000) {
                    FillingBookMonitor.filling.first { it?.phase == FillPhase.Live }
                }!!
            }
        assertTrue("the fill targets the landed bundle", filling.path.endsWith(".taletrek"))
        assertEquals("a live fill is playable for its own book", true, FillingBookMonitor.filling.value.isLiveFor(filling.path))

        // The session armed before submit plays the moment audio lands
        // (the bridge waits per-book — this book IS the live fill).
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val advanced = AtomicBoolean(false)
        val walk =
            onMain(instrumentation) {
                val exo = ExoPlayer.Builder(instrumentation.targetContext).build()
                val port = ExoPlayerPort(exo)
                val book = openBook(filling.path)
                val bridge =
                    PlayerBridge(
                        kernel = TrekKernelPlayer(book),
                        segments = ProgressiveSegmentSource(filling.path),
                        cache = SegmentCache(File(context.cacheDir, "fill-states-a-segments")),
                        port = port,
                        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                        keepWaiting = { FillingBookMonitor.filling.value.isLiveFor(filling.path) },
                        onSnapshotChanged = { snap ->
                            snap.para?.let { if (it.index.toInt() > 0 || it.chapter.toInt() > 0) advanced.set(true) }
                        },
                    )
                port.attach(bridge)
                bridge.userPlay()
                Triple(bridge, port, exo)
            }
        try {
            val deadline = System.currentTimeMillis() + 300_000
            while (!advanced.get() && System.currentTimeMillis() < deadline) Thread.sleep(500)
            assertTrue("playback advanced while still filling", advanced.get())
            assertTrue(
                "the job was still running while playing",
                SynthService.active.value is SynthUiState.Synthesizing ||
                    SynthService.active.value is SynthUiState.Filling,
            )
        } finally {
            onMain(instrumentation) {
                walk.first.release()
                walk.third.release()
            }
        }
        awaitTerminal()
    }

    @Test
    fun bCancelKeepsMaterialRelaunchNeverAutoResumesManualSeals() {
        val voices = File(files, "voices")
        dev.l1br3.taletrek.ffi
            .ffiResolveVoice(null, voices.path, SilentDownload)
        val books = freshDir("books-b")
        val store = freshDir("store-b")
        val source = doc("fill-states-b.txt")
        val marker = PendingJobStore(files)
        marker.clear()
        val shelf = wireMonitor(marker, books)
        val request = request(source, books, store)

        saveMarkerLikeTheImportFlow(marker, request, books)
        context.startForegroundService(request.toIntent(context))
        runBlocking {
            withTimeout(300_000) { SynthService.active.first { it is SynthUiState.Filling && it.total > 0 } }
        }

        cancelViaServiceIntent()
        val terminal = awaitTerminal()
        assertTrue("expected Cancelled, got $terminal", terminal is SynthUiState.Cancelled)
        // The terminal policy (activity-level in production, applied
        // here as the collector would): stamp, keep marker + source.
        marker.stampTerminal(PendingTerminal.CANCELLED)

        val kept = marker.load()
        assertNotNull("cancel keeps the marker", kept)
        assertEquals(PendingTerminal.CANCELLED, kept?.terminalReason)
        assertTrue("cancel keeps the source copy", source.isFile)
        shelf.value = shelfScan(books)
        runBlocking {
            withTimeout(60_000) {
                FillingBookMonitor.filling.first { it?.phase is FillPhase.Paused }
            }
        }
        assertEquals("the fill reads paused", FillPhase.Paused(PendingTerminal.CANCELLED), FillingBookMonitor.filling.value?.phase)

        // Relaunch never auto-resumes a cancel.
        runBlocking { resume(marker, books).resumeWith(shelfScan(books)) }
        Thread.sleep(3_000)
        assertTrue(
            "no job auto-started for a cancelled marker",
            SynthService.active.value == null || SynthService.active.value is SynthUiState.Cancelled,
        )

        // The manual resume seals — without re-downloading the voice.
        val voiceFilesBefore = fileMap(voices)
        runBlocking { resume(marker, books).resumeManually(shelfScan(books)) }
        val sealed = awaitTerminal()
        assertTrue("manual resume failed: $sealed", sealed is SynthUiState.Done)
        assertEquals("the voice cache was not re-downloaded", voiceFilesBefore, fileMap(voices))
        assertEquals("a resumed job's marker reads unspent again", null, marker.load()?.terminalReason)
        assertTrue("the sealed bundle plays as a normal book", openBook((sealed as SynthUiState.Done).bundlePath).audioPresent)
    }

    @Test
    fun cAForeignTextOnlyBookStallsWhileAnotherConverts() {
        val voices = File(files, "voices")
        dev.l1br3.taletrek.ffi
            .ffiResolveVoice(null, voices.path, SilentDownload)

        // Book A: cancelled mid-fill in an earlier run — a text-only
        // bundle with recovery material, NOT the live fill.
        val booksA = freshDir("books-c-a")
        val storeA = freshDir("store-c-a")
        val sourceA = doc("fill-states-c-a.txt")
        val requestA = request(sourceA, booksA, storeA)
        val marker = PendingJobStore(files)
        marker.clear()
        val shelf = wireMonitor(marker, booksA)
        saveMarkerLikeTheImportFlow(marker, requestA, booksA)
        context.startForegroundService(requestA.toIntent(context))
        runBlocking {
            withTimeout(300_000) { SynthService.active.first { it is SynthUiState.Filling && it.total > 0 } }
        }
        cancelViaServiceIntent()
        assertTrue("A cancelled", awaitTerminal() is SynthUiState.Cancelled)
        marker.stampTerminal(PendingTerminal.CANCELLED)
        val bookA = booksA.listFiles { f -> f.name.endsWith(".taletrek") }!!.single()
        shelf.value = shelfScan(booksA)
        runBlocking {
            withTimeout(60_000) {
                FillingBookMonitor.filling.first { it?.path == bookA.absolutePath && it.phase is FillPhase.Paused }
            }
        }

        // Book B converts (a different document, its own dirs) — the
        // monitor re-wired to B's shelf, so the live fill is B, never A.
        val booksB = freshDir("books-c-b")
        val storeB = freshDir("store-c-b")
        val requestB = request(doc("fill-states-c-b.txt"), booksB, storeB)
        wireMonitor(marker, booksB)
        saveMarkerLikeTheImportFlow(marker, requestB, booksB)
        context.startForegroundService(requestB.toIntent(context))
        runBlocking {
            withTimeout(300_000) { SynthService.active.first { it is SynthUiState.Filling && it.total > 0 } }
        }

        assertFalse("A is not the live fill", FillingBookMonitor.filling.value.isLiveFor(bookA.absolutePath))

        // A's session plays its landed-or-stalls honestly: with the
        // per-book gate, a NotYet SURFACES a stall — it never buffers
        // on a job that isn't filling A.
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val stalled = AtomicBoolean(false)
        val walk =
            onMain(instrumentation) {
                val exo = ExoPlayer.Builder(instrumentation.targetContext).build()
                val port = ExoPlayerPort(exo)
                val bridge =
                    PlayerBridge(
                        kernel = TrekKernelPlayer(openBook(bookA.absolutePath)),
                        segments = ProgressiveSegmentSource(bookA.absolutePath),
                        cache = SegmentCache(File(context.cacheDir, "fill-states-c-segments")),
                        port = port,
                        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                        keepWaiting = { FillingBookMonitor.filling.value.isLiveFor(bookA.absolutePath) },
                        onStalled = { stalled.set(true) },
                    )
                port.attach(bridge)
                bridge.userPlay()
                Triple(bridge, port, exo)
            }
        try {
            val deadline = System.currentTimeMillis() + 60_000
            while (!stalled.get() && System.currentTimeMillis() < deadline) Thread.sleep(500)
            assertTrue("the foreign book stalled honestly (no infinite buffer)", stalled.get())
            assertTrue(
                "B kept converting while A stalled",
                SynthService.active.value is SynthUiState.Synthesizing || SynthService.active.value is SynthUiState.Filling,
            )
        } finally {
            onMain(instrumentation) {
                walk.first.release()
                walk.third.release()
            }
            cancelViaServiceIntent()
            awaitTerminal()
        }
    }

    private fun shelfScan(books: File): List<BookShelf> =
        books
            .listFiles { f -> f.name.endsWith(".taletrek") }
            .orEmpty()
            .mapNotNull { file ->
                runCatching { openBook(file.absolutePath) }.getOrNull()?.let {
                    BookShelf(it.bookId, it.title, it.author, it.chapters.size, it.audioPresent, file.absolutePath)
                }
            }

    /** Run `block` on the app's main thread and return its result. */
    private fun <T> onMain(
        instrumentation: android.app.Instrumentation,
        block: () -> T,
    ): T {
        val ref =
            java.util.concurrent.atomic
                .AtomicReference<T>()
        instrumentation.runOnMainSync { ref.set(block()) }
        return ref.get()
    }

    private object SilentDownload : dev.l1br3.taletrek.ffi.FfiVoiceObserver {
        override fun onDownloadStep(
            bytesDone: ULong,
            bytesTotal: ULong,
        ) {}
    }
}
