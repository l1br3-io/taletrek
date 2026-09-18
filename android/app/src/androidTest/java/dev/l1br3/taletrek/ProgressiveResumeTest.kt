package dev.l1br3.taletrek

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.l1br3.taletrek.ffi.openBook
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * THE resume story on one device, through the real service: a job
 * mid-fill leaves the on-disk death state (source copy, text-only
 * bundle, warm segment store — the marker alongside them is the import
 * flow's, JVM-pinned in task 009), and a re-submitted job seals from
 * the store without re-downloading the voice or re-synthesizing what
 * the store already holds. The true process-kill/relaunch leg rides
 * the device pass (task 012): the marker+resume decision chain is
 * JVM-pinned; this test pins the kernel/store contract it drives.
 */
@RunWith(AndroidJUnit4::class)
class ProgressiveResumeTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    private fun freshDir(name: String): File {
        val dir = File(files, "progressive-resume/$name")
        dir.deleteRecursively()
        dir.mkdirs()
        return dir
    }

    /** Distinct text per `name` — distinct cache keys per document (the
     *  store is content-addressed; identical paragraphs would full-hit). */
    private fun doc(name: String): File {
        val text =
            buildString {
                appendLine("the resume walk ($name)")
                repeat(48) { i -> appendLine("\n$name paragraph $i of the resume document says some words.") }
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

    private fun awaitFreshTerminal(): SynthUiState =
        runBlocking {
            val before = SynthService.active.value
            withTimeout(300_000) { SynthService.active.first { it != before } }
            withTimeout(600_000) {
                SynthService.active.first {
                    it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                }!!
            }
        }

    private fun fileMap(dir: File): Map<String, Long> =
        dir
            .walkTopDown()
            .filter { it.isFile }
            .associate { it.relativeTo(dir).path to it.length() }

    private fun storeFileCount(store: File): Int = store.walkTopDown().filter { it.isFile }.count()

    @Test
    fun anInterruptedJobsOnDiskStateResumesFromTheStoreWithoutResynthesis() {
        val voices = File(files, "voices")
        dev.l1br3.taletrek.ffi
            .ffiResolveVoice(null, voices.path, SilentDownload)

        val source = doc("progressive-resume-source.txt")
        val books = freshDir("books")
        val store = freshDir("segments")

        // Run one: a full progressive convert of the document.
        val runOneStart = System.nanoTime()
        context.startForegroundService(request(source, books, store).toIntent(context))
        val runOne = awaitFreshTerminal()
        assertTrue("run one failed: $runOne", runOne is SynthUiState.Done)
        val runOneWallMs = (System.nanoTime() - runOneStart) / 1_000_000L
        val storeAfterOne = storeFileCount(store)
        assertTrue("run one filled the store", storeAfterOne > 0)

        // The mid-job death state, observed while a second document
        // fills: source copy + text-only bundle + store contents all on
        // disk simultaneously — exactly what process death leaves.
        val runTwoSource = doc("progressive-resume-source-2.txt")
        val runTwoBooks = freshDir("books-2")
        context.startForegroundService(request(runTwoSource, runTwoBooks, store).toIntent(context))
        runBlocking {
            withTimeout(300_000) {
                SynthService.active.first { it is SynthUiState.Synthesizing && it.done >= 4 }
            }
        }
        assertTrue("the source copy lives while the job runs", runTwoSource.isFile)
        val fillingBundle = runTwoBooks.listFiles { f -> f.name.endsWith(".taletrek") }!!.single()
        assertFalse("mid-job bundle is the filling text-only book", openBook(fillingBundle.absolutePath).audioPresent)
        val storeMidRun = storeFileCount(store)
        assertTrue("store holds synthesized segments mid-job", storeMidRun > storeAfterOne)
        val runTwo = awaitFreshTerminal()
        assertTrue("run two failed: $runTwo", runTwo is SynthUiState.Done)
        val storeAfterTwo = storeFileCount(store)

        // Run three — the resume contract: same document, same store.
        // No voice re-download (the cache's files are untouched) and no
        // re-synthesis (the store gains nothing; the seal reads it).
        val voiceFilesBefore = fileMap(voices)
        val runThreeStart = System.nanoTime()
        val resumeBooks = freshDir("books-3")
        context.startForegroundService(request(source, resumeBooks, store).toIntent(context))
        val runThree = awaitFreshTerminal()
        val runThreeWallMs = (System.nanoTime() - runThreeStart) / 1_000_000L
        assertTrue("resume run failed: $runThree", runThree is SynthUiState.Done)

        assertEquals("the voice cache was not re-downloaded", voiceFilesBefore, fileMap(voices))
        assertEquals("no segments were re-synthesized", storeAfterTwo, storeFileCount(store))

        val sealed = openBook(File((runThree as SynthUiState.Done).bundlePath).absolutePath)
        assertTrue("the resumed book sealed to a full bundle", sealed.audioPresent)
        val paragraphs = sealed.chapters.sumOf { it.paragraphs.size }
        assertTrue("the sealed book has its paragraphs", paragraphs > 0)

        android.util.Log.i(
            "ProgressiveResumeTest",
            "full run ${runOneWallMs}ms vs store-resume ${runThreeWallMs}ms ($storeAfterOne segments reused)",
        )
        assertTrue(
            "store-resume should be far cheaper than the full run ($runThreeWallMs vs $runOneWallMs)",
            runThreeWallMs < runOneWallMs / 2,
        )
    }

    private object SilentDownload : dev.l1br3.taletrek.ffi.FfiVoiceObserver {
        override fun onDownloadStep(
            bytesDone: ULong,
            bytesTotal: ULong,
        ) {}
    }
}
