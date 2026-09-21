package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.data.BookShelf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The fill authority over fakes — one reactive derivation answers "is
 * *this* book filling?" for every consumer (reader arming, bridge
 * waiting, reanchor routing, library rows). The pinned ordering is the
 * spec's: marker → bundle lands in a shelf scan → filling.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FillingBookMonitorTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var source: File
    private lateinit var store: PendingJobStore
    private val shelf = MutableStateFlow<List<BookShelf>>(emptyList())
    private val active = MutableStateFlow<SynthUiState?>(null)
    private var sourceOnDisk = true
    private var rescans = 0

    @Before
    fun setUp() {
        source = tmp.newFile("import-source-1")
        store = PendingJobStore(tmp.newFolder())
        shelf.value = emptyList()
        active.value = null
        sourceOnDisk = true
        rescans = 0
    }

    private fun TestScope.monitor(): FillingBookMonitor =
        FillingBookMonitor(
            store = store,
            shelf = shelf,
            active = active,
            sourceAlive = { sourceOnDisk },
            rescan = {
                rescans++
                shelf.value = shelf.value // scans re-emit; tests drive content by hand
            },
            scope = CoroutineScope(StandardTestDispatcher(testScheduler) + Job()),
        )

    private fun book(
        bookId: String,
        audio: Boolean = false,
    ) = BookShelf(
        bookId = bookId,
        title = bookId,
        author = null,
        chapterCount = 3,
        audioPresent = audio,
        path = "/files/books/$bookId.taletrek",
    )

    private fun markerWith(vararg preExisting: String) {
        store.save(
            PendingJobStore.PendingJob(
                request =
                    SynthJobRequest(
                        sourcePath = source.absolutePath,
                        hint = "novel.epub",
                        voiceId = "vo_x",
                        voiceCacheDir = "/files/voices",
                        espeakDir = "/files/espeak",
                        booksDir = "/files/books",
                        storeDir = "/cache/taletrek/segments",
                        jobs = 2,
                        generatorApp = "taletrek-android",
                        initialAnchor = null,
                    ),
                preExistingBookPaths = preExisting.toList(),
            ),
        )
    }

    @Test
    fun markerThenBundleLandsEmitsLiveForThatBook() =
        runTest {
            markerWith("/files/books/bk_old.taletrek")
            val monitor = monitor().also { it.start() }
            advanceUntilIdle()

            // Pre-submit / pre-parse: the marker alone is not a fill.
            shelf.value = listOf(book("bk_old", audio = true))
            advanceUntilIdle()
            assertNull(monitor.filling.value)

            // The job goes live, the bundle lands in a scan → filling.
            active.value = SynthUiState.Filling(3, 9)
            shelf.value = listOf(book("bk_old", audio = true), book("bk_new"))
            advanceUntilIdle()
            assertEquals(FillingBook("/files/books/bk_new.taletrek", "bk_new", FillPhase.Live), monitor.filling.value)
        }

    @Test
    fun aLiveJobBeforeTheBundleLandsStaysNullAndRescans() =
        runTest {
            markerWith("/files/books/bk_old.taletrek")
            val monitor = monitor().also { it.start() }
            shelf.value = listOf(book("bk_old", audio = true))
            active.value = SynthUiState.Preparing(null, null)
            advanceUntilIdle()
            assertNull("no candidate yet", monitor.filling.value)

            // The unresolved-running window rescans on its ticker.
            advanceTimeBy(FillingBookMonitor.RESCAN_INTERVAL_MS + 1)
            assertTrue("rescan fired while unresolved", rescans >= 1)

            // The bundle lands → live, and the ticker stops mattering.
            shelf.value = listOf(book("bk_old", audio = true), book("bk_new"))
            advanceUntilIdle()
            assertEquals(FillPhase.Live, monitor.filling.value?.phase)
        }

    @Test
    fun terminalNullsTheFillAndTheStampPausesIt() =
        runTest {
            markerWith()
            val monitor = monitor().also { it.start() }
            active.value = SynthUiState.Filling(3, 9)
            shelf.value = listOf(book("bk_new"))
            advanceUntilIdle()
            assertEquals(FillPhase.Live, monitor.filling.value?.phase)

            // Cancel lands: unspent window (stamp pending) → null…
            active.value = SynthUiState.Cancelled
            advanceUntilIdle()
            assertNull(monitor.filling.value)

            // …the stamp arrives → paused-with-recovery.
            store.stampTerminal(PendingTerminal.CANCELLED)
            advanceUntilIdle()
            assertEquals(
                FillingBook("/files/books/bk_new.taletrek", "bk_new", FillPhase.Paused(PendingTerminal.CANCELLED)),
                monitor.filling.value,
            )
        }

    @Test
    fun aPausedFillWithoutItsSourceIsNull() =
        runTest {
            markerWith()
            store.stampTerminal(PendingTerminal.FAILED)
            sourceOnDisk = false
            val monitor = monitor().also { it.start() }
            shelf.value = listOf(book("bk_new"))
            advanceUntilIdle()
            assertNull(monitor.filling.value)
        }

    @Test
    fun anUnspentMarkerWithoutALiveJobIsNullTheRelaunchWindow() =
        runTest {
            markerWith()
            val monitor = monitor().also { it.start() }
            shelf.value = listOf(book("bk_new"))
            advanceUntilIdle()
            assertNull(monitor.filling.value)
        }

    @Test
    fun aSpentMarkerIsNull() =
        runTest {
            markerWith()
            store.clear()
            val monitor = monitor().also { it.start() }
            active.value = SynthUiState.Done("bk_new", "/files/books/bk_new.taletrek")
            shelf.value = listOf(book("bk_new", audio = true))
            advanceUntilIdle()
            assertNull(monitor.filling.value)
        }

    @Test
    fun anotherBooksFillNeverAnswersForThisBook() =
        runTest {
            markerWith()
            val monitor = monitor().also { it.start() }
            active.value = SynthUiState.Filling(3, 9)
            shelf.value = listOf(book("bk_a"), book("bk_b", audio = true))
            advanceUntilIdle()

            assertEquals("bk_filling", "/files/books/bk_a.taletrek", monitor.filling.value?.path)
            assertFalse(monitor.filling.value.isLiveFor("/files/books/bk_b.taletrek"))
            assertTrue(monitor.filling.value.isLiveFor("/files/books/bk_a.taletrek"))
            assertFalse(monitor.filling.value.isLiveFor(null))
        }

    @Test
    fun aPausedFillIsNotLiveForRouting() =
        runTest {
            markerWith()
            store.stampTerminal(PendingTerminal.CANCELLED)
            val monitor = monitor().also { it.start() }
            shelf.value = listOf(book("bk_new"))
            advanceUntilIdle()
            assertFalse(monitor.filling.value.isLiveFor("/files/books/bk_new.taletrek"))
        }

    @Test
    fun anAmbiguousShelfResolvesToNull() =
        runTest {
            markerWith()
            val monitor = monitor().also { it.start() }
            active.value = SynthUiState.Filling(3, 9)
            shelf.value = listOf(book("bk_a"), book("bk_b"))
            advanceUntilIdle()
            assertNull(monitor.filling.value)
        }

    @Test
    fun snapshotMembersNeverFill() =
        runTest {
            markerWith("/files/books/bk_desktop.taletrek")
            val monitor = monitor().also { it.start() }
            active.value = SynthUiState.Filling(3, 9)
            shelf.value = listOf(book("bk_desktop"))
            advanceUntilIdle()
            assertNull(monitor.filling.value)
        }
}
