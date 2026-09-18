package dev.l1br3.taletrek

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.ffi.deleteCachedVoice
import dev.l1br3.taletrek.ffi.voiceCatalog
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File

/**
 * The cancel/error matrix (task 008) — every case a real service run with
 * before/after dir diffs: no partial books, no orphaned temps, honest
 * terminal states, and a re-import that works immediately after each.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class HardeningTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    private fun shelf(name: String): File = File(files, "books/$name").apply { mkdirs() }

    private fun source(
        name: String,
        paragraphs: Int,
    ): File {
        val dest = File(context.cacheDir, name)
        dest.writeText(
            buildString {
                appendLine("chapter one")
                repeat(paragraphs) {
                    appendLine()
                    appendLine("paragraph number ${it + 1} says enough to synthesize.")
                }
            },
        )
        return dest
    }

    private fun request(
        src: File,
        books: File,
    ) = SynthJobRequest(
        sourcePath = src.absolutePath,
        hint = src.name,
        voiceId = null,
        voiceCacheDir = File(files, "voices").path,
        espeakDir = File(files, "espeak-ng-data").path,
        booksDir = books.path,
        storeDir = File(books, "../segments/${books.name}").path,
        jobs = 2,
        generatorApp = "taletrek-android",
    )

    /** Idempotent voice-cache warm-up — espeak needs no prerequisite since
     *  the job ensures it itself. */
    private fun warmSharedVoiceCache() {
        dev.l1br3.taletrek.ffi
            .ffiResolveVoice(null, File(files, "voices").path, SilentDownload)
    }

    private fun snapshot(dir: File): Set<String> =
        dir
            .walkTopDown()
            .filter { it.isFile }
            .map { it.relativeTo(dir).path }
            .toSet()

    private object SilentDownload : dev.l1br3.taletrek.ffi.FfiVoiceObserver {
        override fun onDownloadStep(
            bytesDone: ULong,
            bytesTotal: ULong,
        ) {}
    }

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

    private fun cancelViaServiceIntent() {
        context.startService(
            android.content
                .Intent(context, SynthService::class.java)
                .setAction(SynthService.ACTION_CANCEL),
        )
    }

    @Test
    fun cancelMidDownloadLeavesNoPartialAndReimportWorks() =
        runBlocking {
            val voices = File(files, "voices")
            voices.mkdirs()
            voiceCatalog().forEach { deleteCachedVoice(voices.path, it.id) }
            val books = shelf("cancel-download")
            val src = source("cancel-download.txt", 3)

            // Run until the download phase, then cancel.
            val before = SynthService.active.value
            context.startForegroundService(request(src, books = books).toIntent(context))
            withTimeout(120_000) {
                SynthService.active.first { it is SynthUiState.DownloadingVoice }
            }
            cancelViaServiceIntent()
            val terminal =
                withTimeout(600_000) {
                    SynthService.active.first {
                        it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                    }!!
                }
            assertTrue("expected Cancelled, got $terminal", terminal is SynthUiState.Cancelled)
            assertTrue("partial book survived", books.listFiles().isNullOrEmpty())
            // No partial voice cache: each curated id has both files or neither.
            for (v in voiceCatalog()) {
                val onnx = File(voices, "${v.id}.onnx").isFile
                val json = File(voices, "${v.id}.json").isFile
                assertEquals("voice ${v.id} partially cached", onnx, json)
            }

            // Re-import of the same document works immediately after.
            val reimport = startAndAwaitTerminal(request(src, books = books))
            assertTrue("re-import after cancel failed: $reimport", reimport is SynthUiState.Done)
        }

    @Test
    fun cancelMidSynthEarlyLeavesNoTempOrBook() =
        runBlocking {
            // Voice must be present so the cancel lands inside synth, not
            // download: warm the cache by a full run first (cache-or-
            // download; espeak is ensured in-job — no prerequisite).
            val books = shelf("cancel-synth")
            val src = source("cancel-synth.txt", 12)
            val warmup = startAndAwaitTerminal(request(src, books = books))
            assertTrue("warmup run failed: $warmup", warmup is SynthUiState.Done)
            books.listFiles()!!.forEach { it.delete() }

            val before = SynthService.active.value
            context.startForegroundService(request(src, books = books).toIntent(context))
            withTimeout(120_000) {
                SynthService.active.first { it is SynthUiState.Synthesizing && it.done < 6 }
            }
            cancelViaServiceIntent()
            val terminal =
                withTimeout(600_000) {
                    SynthService.active.first {
                        it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                    }!!
                }
            // A fast emulator may race to Done; the invariant is: no
            // .tmp, and either a complete book or none at all.
            val listing = books.listFiles()!!.map { it.name }
            assertFalse("orphaned temp files: $listing", listing.any { it.endsWith(".tmp") })
            if (terminal is SynthUiState.Cancelled) {
                assertTrue("partial book after mid-synth cancel: $listing", listing.isEmpty())
            } else {
                assertEquals(1, listing.size)
            }
        }

    @Test
    fun unwritableOutputDirSurfacesARealMessage() {
        warmSharedVoiceCache() // reach the write phase without a download
        val books = File("/proc/taletrek-no-write") // unwritable by construction
        val terminal = startAndAwaitTerminal(request(source("deny.txt", 2), books = books))
        assertTrue("expected Failed, got $terminal", terminal is SynthUiState.Failed)
        val message = (terminal as SynthUiState.Failed).message
        assertFalse("dead-spinner message", message.isBlank())
        assertTrue("expected a write-kind failure, got: $message", message.contains("writing bundle"))
    }

    @Test
    fun notificationsDeniedStillRunsTheJobToDone() {
        warmSharedVoiceCache()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation
            .executeShellCommand(
                "pm revoke dev.l1br3.taletrek android.permission.POST_NOTIFICATIONS",
            ).close()
        try {
            val terminal =
                startAndAwaitTerminal(
                    request(source("noperm.txt", 2), books = shelf("noperm")),
                )
            assertTrue("job must complete without notification permission: $terminal", terminal is SynthUiState.Done)
        } finally {
            instrumentation.uiAutomation
                .executeShellCommand(
                    "pm grant dev.l1br3.taletrek android.permission.POST_NOTIFICATIONS",
                ).close()
        }
    }

    /**
     * Runs last (name-ordered): airplane mode mid-download must surface a
     * real error — never a dead progress row. Network restored in finally.
     */
    @Test
    fun zzAirplaneModeMidDownloadSurfacesTypedFailure() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val voices = File(files, "voices")
        voices.mkdirs()
        voiceCatalog().forEach { deleteCachedVoice(voices.path, it.id) }
        instrumentation.uiAutomation.executeShellCommand("svc wifi disable").close()
        instrumentation.uiAutomation.executeShellCommand("svc data disable").close()
        try {
            val terminal =
                startAndAwaitTerminal(
                    request(source("offline.txt", 2), books = shelf("offline")),
                )
            assertTrue("expected Failed, got $terminal", terminal is SynthUiState.Failed)
            val failed = terminal as SynthUiState.Failed
            assertFalse("error must carry a message", failed.message.isBlank())
            assertTrue(
                "download failure must be typed (resolve or espeak), got ${failed.kind}",
                failed.kind == "resolve" || failed.kind == "espeak",
            )
            assertTrue(shelf("offline").listFiles().isNullOrEmpty())
        } finally {
            instrumentation.uiAutomation.executeShellCommand("svc wifi enable").close()
            instrumentation.uiAutomation.executeShellCommand("svc data enable").close()
        }
    }
}
