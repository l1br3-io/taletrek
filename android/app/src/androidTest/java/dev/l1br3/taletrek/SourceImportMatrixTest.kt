package dev.l1br3.taletrek

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.ffi.cachedVoiceIds
import dev.l1br3.taletrek.ffi.ffiEnsureEspeak
import dev.l1br3.taletrek.ffi.ffiResolveVoice
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The six-format convert matrix (task 006): every source type goes through
 * the REAL service + REAL kernel as a text-only import (no voice, no
 * network); the full-synth leg (one format, real sherpa from the CDN voice
 * the T2 spike pattern resolves) proves the Listen path end to end —
 * book lands in `files/books`, the library scan shape, re-import
 * idempotence, and text-only→full overwrite.
 */
@RunWith(AndroidJUnit4::class)
class SourceImportMatrixTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    private fun stage(asset: String): File {
        val dest = File(context.cacheDir, asset)
        InstrumentationRegistry
            .getInstrumentation()
            .context.assets
            .open("sources/$asset")
            .use { input -> dest.outputStream().use { input.copyTo(it) } }
        return dest
    }

    /** Per-test shelf isolation — counts must not see other tests' books. */
    private fun shelf(name: String): File = File(files, "books/$name").apply { mkdirs() }

    private fun request(
        source: File,
        textOnly: Boolean,
        books: File,
    ) = SynthJobRequest(
        sourcePath = source.absolutePath,
        hint = source.name,
        textOnly = textOnly,
        voiceId = null,
        voiceCacheDir = File(files, "voices").absolutePath,
        espeakDir = File(files, "espeak-ng-data").absolutePath,
        booksDir = books.absolutePath,
        jobs = 2,
        generatorApp = "taletrek-android",
    )

    /**
     * Start one job and await ITS terminal (not a stale one): a fresh
     * controller resets the slot to null between jobs, so first observe
     * any change from the snapshot, then the terminal. If a job races to
     * an identical terminal before any observable change, the wait fails
     * loudly (timeout) rather than passing on the previous outcome.
     */
    private fun startAndAwaitTerminal(request: SynthJobRequest): SynthUiState =
        runBlocking {
            val before = SynthService.active.value
            context.startForegroundService(request.toIntent(context))
            withTimeout(120_000) {
                SynthService.active.first { it != before }
            }
            withTimeout(120_000) {
                SynthService.active.first {
                    it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                }!!
            }
        }

    @Test
    fun allSixFormatsImportTextOnly() {
        val sources =
            listOf(
                "plain.txt",
                "book.md",
                "article.html",
                "book.epub",
                "doc.docx",
                "no-outline.pdf",
            )
        val shelf = shelf("all-six")
        for (name in sources) {
            val terminal = startAndAwaitTerminal(request(stage(name), textOnly = true, books = shelf))
            assertTrue("import of $name failed: $terminal", terminal is SynthUiState.Done)
            val done = terminal as SynthUiState.Done
            assertTrue(done.textOnly)
            assertTrue(File(done.bundlePath).isFile)
        }
        // Distinct content ⇒ distinct ids — six books on this shelf.
        assertEquals(6, shelf.listFiles { f -> f.name.endsWith(".taletrek") }!!.size)
    }

    @Test
    fun reImportIsIdempotentOneShelfEntry() {
        val shelf = shelf("reimport")
        val first = startAndAwaitTerminal(request(stage("plain.txt"), textOnly = true, books = shelf))
        val idA = (first as SynthUiState.Done).bookId
        val second = startAndAwaitTerminal(request(stage("plain.txt"), textOnly = true, books = shelf))
        val idB = (second as SynthUiState.Done).bookId
        assertEquals("same document ⇒ same deterministic id", idA, idB)
        assertEquals(
            "deterministic ids overwrite — one shelf entry",
            1,
            shelf.listFiles { f -> f.name.endsWith(".taletrek") }!!.size,
        )
    }

    @Test
    fun garbageSurfacesFailureWithNoLibraryResidue() {
        val garbage = File(context.cacheDir, "garbage.dat")
        garbage.writeBytes(byteArrayOf(0x00, 0x01, 0x02, 0x03))
        val shelf = shelf("garbage")
        val before = shelf.listFiles()!!.size
        val terminal = startAndAwaitTerminal(request(garbage, textOnly = true, books = shelf))
        assertTrue("expected a typed failure, got $terminal", terminal is SynthUiState.Failed)
        assertTrue((terminal as SynthUiState.Failed).message.isNotBlank())
        assertEquals("no library residue", before, shelf.listFiles()!!.size)
    }

    /**
     * The Listen leg: real voice resolve (CDN on first run, cached after)
     * + real espeak data + real sherpa synth through the service. One
     * format; also pins text-only → full overwrite (same id, audio now
     * present — the designed behavior from the task).
     */
    @Test
    fun fullSynthOverwritesTheTextOnlyEntryWithAudio() =
        runBlocking {
            // Voice gate prerequisites (idempotent; ~63 MB + 9 MB first run).
            val voices = File(files, "voices")
            ffiResolveVoice(null, voices.absolutePath, NoDownloadProgress)
            ffiEnsureEspeak(files.absolutePath, NoDownloadProgress)
            assertTrue(cachedVoiceIds(voices.absolutePath).isNotEmpty())

            val shelf = shelf("full-synth")
            val pdf = stage("no-outline.pdf")
            val textOnly = startAndAwaitTerminal(request(pdf, textOnly = true, books = shelf))
            val textId = (textOnly as SynthUiState.Done).bookId
            assertTrue(textOnly.textOnly)

            val full = startAndAwaitTerminal(request(pdf, textOnly = false, books = shelf))
            assertTrue("full synth failed: $full", full is SynthUiState.Done)
            val fullDone = full as SynthUiState.Done
            assertFalse(fullDone.textOnly)
            assertEquals("text-only and full share the deterministic id", textId, fullDone.bookId)
            assertEquals(
                "overwrite, not duplicate",
                1,
                shelf.listFiles { f -> f.name == "$textId.taletrek" }!!.size,
            )
            // Audio actually present: the bundle opens with audio metadata.
            val book =
                dev.l1br3.taletrek.ffi
                    .openBook(fullDone.bundlePath)
            assertTrue(book.audioPresent)
            assertNotNull(
                book.chapters
                    .first()
                    .paragraphs
                    .first(),
            )
        }

    private object NoDownloadProgress : dev.l1br3.taletrek.ffi.FfiVoiceObserver {
        override fun onDownloadStep(
            bytesDone: ULong,
            bytesTotal: ULong,
        ) {}
    }
}
