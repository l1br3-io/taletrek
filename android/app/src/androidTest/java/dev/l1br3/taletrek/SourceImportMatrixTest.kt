package dev.l1br3.taletrek

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.ffi.cachedVoiceIds
import dev.l1br3.taletrek.ffi.ffiResolveVoice
import dev.l1br3.taletrek.ffi.openBook
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The six-format convert matrix: every source type goes through the REAL
 * service + REAL kernel as a full audio import on the pre-warmed shared
 * voice cache — the pipeline ensures espeak-ng-data itself in-job (the
 * shared-dirs regression coverage for the fix). Books land in
 * `files/books`; the re-import leg pins deterministic-id idempotence with
 * audio; the garbage leg proves parse fails before any download. Fresh-run
 * (no cache at all) is FirstRunTest's story, not this suite's.
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

    /** Idempotent cache-or-download warm-up (~63 MB first run of the
     *  suite; every later test reuses it). The espeak prerequisite is
     *  gone by design — the job ensures it. */
    private fun warmSharedVoiceCache() {
        val voices = File(files, "voices")
        ffiResolveVoice(null, voices.absolutePath, NoDownloadProgress)
        assertTrue(cachedVoiceIds(voices.absolutePath).isNotEmpty())
    }

    private fun request(
        source: File,
        books: File,
    ) = SynthJobRequest(
        sourcePath = source.absolutePath,
        hint = source.name,
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
            withTimeout(600_000) {
                SynthService.active.first {
                    it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                }!!
            }
        }

    @Test
    fun allSixFormatsConvertFull() {
        warmSharedVoiceCache()
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
            val terminal = startAndAwaitTerminal(request(stage(name), shelf))
            assertTrue("full import of $name failed: $terminal", terminal is SynthUiState.Done)
            val done = terminal as SynthUiState.Done
            assertTrue(File(done.bundlePath).isFile)
            assertTrue("audio missing for $name", openBook(done.bundlePath).audioPresent)
        }
        // Distinct content ⇒ distinct ids — six books on this shelf.
        assertEquals(6, shelf.listFiles { f -> f.name.endsWith(".taletrek") }!!.size)
    }

    /**
     * Same-source re-import is idempotent with audio: the deterministic id
     * overwrites in place (one shelf entry), and the bundle reads back
     * with audio + paragraphs. (The old text-only→full overwrite leg
     * folded in here — Android only converts full now; the variant-level
     * overwrite semantics stay covered by the Rust pipeline tests.)
     */
    @Test
    fun fullSynthReImportIsIdempotentWithAudio() {
        warmSharedVoiceCache()
        val shelf = shelf("full-synth")
        val pdf = stage("no-outline.pdf")
        val first = startAndAwaitTerminal(request(pdf, shelf))
        assertTrue("first full synth failed: $first", first is SynthUiState.Done)
        val idA = (first as SynthUiState.Done).bookId

        val second = startAndAwaitTerminal(request(pdf, shelf))
        assertTrue("re-import failed: $second", second is SynthUiState.Done)
        val idB = (second as SynthUiState.Done).bookId

        assertEquals("same document ⇒ same deterministic id", idA, idB)
        assertEquals(
            "deterministic ids overwrite — one shelf entry",
            1,
            shelf.listFiles { f -> f.name == "$idA.taletrek" }!!.size,
        )
        val book = openBook((second as SynthUiState.Done).bundlePath)
        assertTrue(book.audioPresent)
        assertNotNull(
            book
                .chapters
                .first()
                .paragraphs
                .first(),
        )
    }

    @Test
    fun garbageSurfacesFailureWithNoLibraryResidue() {
        // Full request: parse fails before any download (the job's order
        // is parse → resolve), so no voice/espeak fetch is attempted.
        val garbage = File(context.cacheDir, "garbage.dat")
        garbage.writeBytes(byteArrayOf(0x00, 0x01, 0x02, 0x03))
        val shelf = shelf("garbage")
        val before = shelf.listFiles()!!.size
        val terminal = startAndAwaitTerminal(request(garbage, shelf))
        assertTrue("expected a typed failure, got $terminal", terminal is SynthUiState.Failed)
        assertTrue((terminal as SynthUiState.Failed).message.isNotBlank())
        assertEquals("no library residue", before, shelf.listFiles()!!.size)
    }

    private object NoDownloadProgress : dev.l1br3.taletrek.ffi.FfiVoiceObserver {
        override fun onDownloadStep(
            bytesDone: ULong,
            bytesTotal: ULong,
        ) {}
    }
}
