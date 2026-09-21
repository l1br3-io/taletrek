package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.ffi.FfiAnchor
import dev.l1br3.taletrek.ffi.FfiPosition
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Relaunch resume over fakes — the process-death story: a pending marker
 * plus its still-cached source re-submit the job, anchored at the stored
 * reading position of the book the interrupted run left filling.
 */
class PendingImportResumeTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var source: File
    private lateinit var store: PendingJobStore
    private val started = mutableListOf<SynthJobRequest>()
    private val positions = mutableMapOf<String, FfiPosition>()
    private var converting = false

    @Before
    fun setUp() {
        source = tmp.newFile("import-source-1")
        store = PendingJobStore(tmp.newFolder())
        started.clear()
        positions.clear()
        converting = false
    }

    private fun shelf(
        bookId: String,
        audio: Boolean,
    ) = BookShelf(
        bookId = bookId,
        title = bookId,
        author = null,
        chapterCount = 3,
        audioPresent = audio,
        path = "/files/books/$bookId.taletrek",
    )

    private fun pendingWith(vararg preExisting: String) {
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

    private fun resume() =
        PendingImportResume(
            store = store,
            loadPosition = { positions[it] },
            isConverting = { converting },
            startJob = { started += it },
        )

    @Test
    fun relaunchWithFillingBookResubmitsAnchoredAtStoredPosition() =
        runTest {
            pendingWith("/files/books/bk_old.taletrek")
            positions["bk_new"] = FfiPosition(chapter = 2u, index = 5u, offset = 1.5)
            resume().resumeWith(
                listOf(shelf("bk_old", audio = true), shelf("bk_new", audio = false)),
            )
            val request = started.single()
            assertEquals(source.absolutePath, request.sourcePath)
            assertEquals(FfiAnchor(chapter = 2u, paragraph = 5u), request.initialAnchor)
        }

    @Test
    fun noStoredPositionResubmitsAtBookStart() =
        runTest {
            pendingWith()
            resume().resumeWith(listOf(shelf("bk_new", audio = false)))
            assertNull(started.single().initialAnchor)
        }

    @Test
    fun noPendingJobNeverSubmits() =
        runTest {
            resume().resumeWith(listOf(shelf("bk_new", audio = false)))
            assertTrue(started.isEmpty())
        }

    @Test
    fun evictedSourceClearsTheMarkerAndNeverSubmits() =
        runTest {
            assertTrue(source.delete())
            pendingWith()
            resume().resumeWith(listOf(shelf("bk_new", audio = false)))
            assertTrue(started.isEmpty())
            assertNull(store.load())
        }

    @Test
    fun ambiguousShelfResubmitsAtBookStart() =
        runTest {
            pendingWith()
            positions["bk_a"] = FfiPosition(chapter = 1u, index = 1u, offset = 0.0)
            positions["bk_b"] = FfiPosition(chapter = 2u, index = 2u, offset = 0.0)
            resume().resumeWith(listOf(shelf("bk_a", audio = false), shelf("bk_b", audio = false)))
            assertNull(started.single().initialAnchor)
        }

    @Test
    fun liveJobBlocksResume() =
        runTest {
            pendingWith()
            converting = true
            resume().resumeWith(listOf(shelf("bk_new", audio = false)))
            assertTrue(started.isEmpty())
            assertEquals(source.absolutePath, store.load()?.request?.sourcePath)
        }

    @Test
    fun aCancelledMarkerNeverAutoSubmitsAndSurvives() =
        runTest {
            pendingWith()
            store.stampTerminal(PendingTerminal.CANCELLED)
            resume().resumeWith(listOf(shelf("bk_new", audio = false)))
            assertTrue(started.isEmpty())
            assertEquals(PendingTerminal.CANCELLED, store.load()?.terminalReason)
        }

    @Test
    fun aFailedMarkerNeverAutoSubmitsAndSurvives() =
        runTest {
            pendingWith()
            store.stampTerminal(PendingTerminal.FAILED)
            resume().resumeWith(listOf(shelf("bk_new", audio = false)))
            assertTrue(started.isEmpty())
            assertEquals(PendingTerminal.FAILED, store.load()?.terminalReason)
        }

    @Test
    fun manualResumeSubmitsAStalledMarker() =
        runTest {
            pendingWith("/files/books/bk_old.taletrek")
            store.stampTerminal(PendingTerminal.CANCELLED)
            positions["bk_new"] = FfiPosition(chapter = 2u, index = 5u, offset = 1.5)
            resume().resumeManually(listOf(shelf("bk_old", audio = true), shelf("bk_new", audio = false)))
            assertEquals(FfiAnchor(chapter = 2u, paragraph = 5u), started.single().initialAnchor)
            assertEquals(source.absolutePath, started.single().sourcePath)
        }

    @Test
    fun manualResumeSubmitsAnUnspentMarkerToo() =
        runTest {
            pendingWith()
            resume().resumeManually(listOf(shelf("bk_new", audio = false)))
            assertEquals(source.absolutePath, started.single().sourcePath)
        }

    @Test
    fun manualResumeWithAnEvictedSourceClearsTheMarker() =
        runTest {
            pendingWith()
            store.stampTerminal(PendingTerminal.CANCELLED)
            assertTrue(source.delete())
            resume().resumeManually(listOf(shelf("bk_new", audio = false)))
            assertTrue(started.isEmpty())
            assertNull(store.load())
        }

    @Test
    fun manualResumeWhileConvertingNeverSubmits() =
        runTest {
            pendingWith()
            converting = true
            resume().resumeManually(listOf(shelf("bk_new", audio = false)))
            assertTrue(started.isEmpty())
        }
}
