package dev.l1br3.taletrek

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.l1br3.taletrek.data.VoiceStore
import dev.l1br3.taletrek.ffi.FfiVoiceObserver
import dev.l1br3.taletrek.ffi.cachedVoiceIds
import dev.l1br3.taletrek.ffi.deleteCachedVoice
import dev.l1br3.taletrek.ffi.ffiResolveVoice
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
 * Voice management against the real cache + real CDN (task 007): a
 * download/delete round-trip, and the selection contract — the DataStore
 * selection is what a full import receives and stamps into the manifest.
 */
@RunWith(AndroidJUnit4::class)
class VoiceFlowTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    private object Silent : FfiVoiceObserver {
        override fun onDownloadStep(
            bytesDone: ULong,
            bytesTotal: ULong,
        ) {}
    }

    @Test
    fun downloadDeleteRoundTripAgainstTheRealCdn() {
        val voices = File(files, "voices")
        val id =
            dev.l1br3.taletrek.ffi
                .voiceCatalog()
                .first()
                .id
        deleteCachedVoice(voices.path, id)

        val model = ffiResolveVoice(id, voices.path, Silent)
        assertTrue(File(model).isFile)
        assertTrue(cachedVoiceIds(voices.path).contains(id))

        assertTrue(deleteCachedVoice(voices.path, id))
        assertFalse(cachedVoiceIds(voices.path).contains(id))

        // Idempotent resolve: a warm re-resolve is offline (cache hit).
        val again = ffiResolveVoice(id, voices.path, Silent)
        assertEquals(model, again)
    }

    /**
     * The selection contract end-to-end: select a NON-default voice in
     * the store, build the import request exactly like the flow does
     * (`voiceId = selectedSnapshot()`), run a full synth — the stamped
     * manifest carries the selected voice.
     */
    @Test
    fun selectionDrivesTheImportVoiceId() =
        runBlocking {
            val store = VoiceStore.fromContext(context)
            val selected = "en_US-ryan-medium"
            store.setSelected(selected)
            assertEquals(selected, store.selectedSnapshot())

            val shelf = File(files, "books/selection").apply { mkdirs() }
            val source = File(context.cacheDir, "selection.pdf")
            InstrumentationRegistryHolder.assets("no-outline.pdf").use { input ->
                source.outputStream().use { input.copyTo(it) }
            }
            val request =
                SynthJobRequest(
                    sourcePath = source.absolutePath,
                    hint = "no-outline.pdf",
                    voiceId = store.selectedSnapshot(),
                    voiceCacheDir = File(files, "voices").path,
                    espeakDir = File(files, "espeak-ng-data").path,
                    booksDir = shelf.path,
                    storeDir = File(files, "segments/voice-selection").path,
                    jobs = 2,
                    generatorApp = "taletrek-android",
                )
            val before = SynthService.active.value
            context.startForegroundService(request.toIntent(context))
            withTimeout(120_000) {
                SynthService.active.first { it != before }
            }
            val terminal =
                withTimeout(600_000) {
                    SynthService.active.first {
                        it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                    }!!
                }
            assertTrue("full synth failed: $terminal", terminal is SynthUiState.Done)
            val book = openBook((terminal as SynthUiState.Done).bundlePath)
            assertTrue(book.audioPresent)
            assertEquals("the stamped manifest carries the selected voice", selected, book.voiceId)
        }

    private object InstrumentationRegistryHolder {
        fun assets(name: String) =
            androidx.test.platform.app.InstrumentationRegistry
                .getInstrumentation()
                .context
                .assets
                .open("sources/$name")
    }
}
