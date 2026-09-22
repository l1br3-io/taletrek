package dev.l1br3.taletrek

import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.ffi.openBook
import dev.l1br3.taletrek.playback.ExoPlayerPort
import dev.l1br3.taletrek.playback.PlayerBridge
import dev.l1br3.taletrek.playback.ProgressiveSegmentSource
import dev.l1br3.taletrek.playback.SegmentCache
import dev.l1br3.taletrek.playback.TrekKernelPlayer
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import dev.l1br3.taletrek.service.isRunningPhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/**
 * THE progressive story, end to end on one device: a warm-voice convert
 * becomes listenable long before it finishes — playback starts on the
 * text-only bundle, buffers through `NotReady` segments, and genuinely
 * advances while the job still reports progress — then the job seals
 * and the same playback session keeps going onto the full bundle.
 */
@RunWith(AndroidJUnit4::class)
class ProgressiveListenTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    private fun freshDir(name: String): File {
        val dir = File(files, "progressive-listen/$name")
        dir.deleteRecursively()
        dir.mkdirs()
        assertTrue("${dir.absolutePath} must start empty", dir.listFiles().isNullOrEmpty())
        return dir
    }

    /** Enough paragraphs that synth outlasts the first minutes of listening. */
    private fun mediumDoc(): File {
        val text =
            buildString {
                appendLine("the listening walk")
                repeat(60) { i -> appendLine("\nparagraph $i says these words aloud so the walk can follow them.") }
            }
        return File(context.cacheDir, "progressive-listen-source.txt").apply { writeText(text) }
    }

    @Test
    fun playbackStartsBeforeSynthCompletesAndSurvivesTheSeal() {
        val voices = File(files, "voices")
        dev.l1br3.taletrek.ffi
            .ffiResolveVoice(null, voices.path, SilentDownload)
        val espeak = File(files, "espeak-ng-data")
        val books = freshDir("books")
        val store = freshDir("segments")
        val source = mediumDoc()

        val request =
            SynthJobRequest(
                sourcePath = source.absolutePath,
                hint = source.name,
                voiceId = null,
                voiceCacheDir = voices.path,
                espeakDir = espeak.path,
                booksDir = books.absolutePath,
                storeDir = store.absolutePath,
                jobs = 2,
                generatorApp = "taletrek-android",
            )

        runBlocking {
            val before = SynthService.active.value
            context.startForegroundService(request.toIntent(context))
            withTimeout(300_000) { SynthService.active.first { it != before } }
        }

        // Playable arrived: the job renders as filling with real counts,
        // and — the assertion this test exists for — it is NOT done.
        val filling =
            runBlocking {
                withTimeout(300_000) {
                    SynthService.active.first { it is SynthUiState.Filling && it.total > 0 } as SynthUiState.Filling
                }
            }
        assertTrue(
            "playback must open before synth completes (done ${filling.done} of ${filling.total})",
            filling.done < filling.total,
        )

        // The early text bundle is already a readable, filling book.
        val bundle = books.listFiles { f -> f.name.endsWith(".taletrek") }!!.single()
        val fillingBook = openBook(bundle.absolutePath)
        assertFalse("the mid-fill bundle is text-only", fillingBook.audioPresent)

        // Real Media3 playback over the filling book: NotReady segments
        // buffer (the bridge waits while the job lives), audio advances
        // past paragraph 0 WHILE the job still runs.
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val walk =
            onMain(instrumentation) {
                val exo = ExoPlayer.Builder(instrumentation.targetContext).build()
                val port = ExoPlayerPort(exo)
                val bridge =
                    PlayerBridge(
                        kernel = TrekKernelPlayer(fillingBook),
                        segments = ProgressiveSegmentSource(bundle.absolutePath),
                        cache = SegmentCache(File(context.cacheDir, "progressive-listen-segments")),
                        port = port,
                        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                        keepWaiting = { SynthService.active.value?.isRunningPhase == true },
                    )
                port.attach(bridge)
                bridge.userPlay()
                Walk(bridge, port, exo)
            }

        try {
            val deadline = System.currentTimeMillis() + 180_000
            var loadsAtAdvance = 0
            while (loadsAtAdvance < 3) {
                assertTrue("playback did not advance in time", System.currentTimeMillis() < deadline)
                Thread.sleep(500)
                loadsAtAdvance = onMain(instrumentation) { walk.port.appliedLoads().size }
            }
            assertTrue(
                "playback advanced while the job had already finished — not the progressive story",
                SynthService.active.value?.isRunningPhase == true,
            )

            // The job seals; the same playback session keeps going.
            val loadsBeforeSeal = onMain(instrumentation) { walk.port.appliedLoads().size }
            val terminal =
                runBlocking {
                    withTimeout(300_000) {
                        SynthService.active.first {
                            it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                        }!!
                    }
                }
            assertTrue("progressive run failed: $terminal", terminal is SynthUiState.Done)

            val sealedBook = openBook(bundle.absolutePath)
            assertTrue("the sealed bundle is a normal full book", sealedBook.audioPresent)

            var loadsAfterSeal = loadsBeforeSeal
            val sealDeadline = System.currentTimeMillis() + 60_000
            while (loadsAfterSeal <= loadsBeforeSeal) {
                assertTrue("playback did not continue after the seal", System.currentTimeMillis() < sealDeadline)
                Thread.sleep(500)
                loadsAfterSeal = onMain(instrumentation) { walk.port.appliedLoads().size }
            }
        } finally {
            onMain(instrumentation) {
                walk.bridge.release()
                walk.exo.release()
            }
        }
    }

    /** Run `block` on the app's main thread and return its result. */
    private fun <T> onMain(
        instrumentation: android.app.Instrumentation,
        block: () -> T,
    ): T {
        val ref = AtomicReference<T>()
        instrumentation.runOnMainSync { ref.set(block()) }
        return ref.get()
    }

    private class Walk(
        val bridge: PlayerBridge,
        val port: ExoPlayerPort,
        val exo: ExoPlayer,
    )

    private object SilentDownload : dev.l1br3.taletrek.ffi.FfiVoiceObserver {
        override fun onDownloadStep(
            bytesDone: ULong,
            bytesTotal: ULong,
        ) {}
    }
}
