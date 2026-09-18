package dev.l1br3.taletrek

import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.ffi.openBook
import dev.l1br3.taletrek.playback.ExoPlayerPort
import dev.l1br3.taletrek.playback.FileSegmentSource
import dev.l1br3.taletrek.playback.PlayerBridge
import dev.l1br3.taletrek.playback.SegmentCache
import dev.l1br3.taletrek.playback.TrekKernelPlayer
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/**
 * THE first-visit story, end to end on one device: isolated fresh dirs (no
 * voice, no espeak-ng-data — never wiping the shared caches other suites
 * warm), a tiny TXT through the REAL service + kernel, the job downloading
 * the default voice (~63 MB) AND espeak-ng-data (~9 MB) from the real CDNs
 * before synthesizing — no manual prerequisite call anywhere, which is the
 * regression catch for the production espeak gap this effort fixes — then
 * real playback over the produced bundle.
 */
@RunWith(AndroidJUnit4::class)
class FirstRunTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    /** Wiped-then-recreated isolation root — the request's dirs point
     *  here, never at the app's shared caches. */
    private fun freshDir(name: String): File {
        val dir = File(files, "firstrun/$name")
        dir.deleteRecursively()
        dir.mkdirs()
        assertTrue("${dir.absolutePath} must start empty", dir.listFiles().isNullOrEmpty())
        return dir
    }

    @Test
    fun freshInstallConvertsAndPlaysWithZeroConfiguration() {
        val t0 = System.nanoTime()
        val voices = freshDir("voices")
        val espeak = freshDir("espeak-ng-data")
        val books = freshDir("books")
        val source =
            File(context.cacheDir, "firstrun-source.txt").apply {
                writeText("chapter one\n\nalpha beta gamma\n\ndelta epsilon\n\nzeta eta theta")
            }

        // The one user act: the file is submitted as-is (kernel-default
        // voice, no prerequisite, no decision).
        val request =
            SynthJobRequest(
                sourcePath = source.absolutePath,
                hint = source.name,
                voiceId = null,
                voiceCacheDir = voices.absolutePath,
                espeakDir = espeak.absolutePath,
                booksDir = books.absolutePath,
                storeDir = freshDir("segments").absolutePath,
                jobs = 2,
                generatorApp = "taletrek-android",
            )
        val terminal =
            runBlocking {
                val before = SynthService.active.value
                context.startForegroundService(request.toIntent(context))
                withTimeout(300_000) {
                    SynthService.active.first { it != before }
                }
                withTimeout(300_000) {
                    SynthService.active.first {
                        it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                    }!!
                }
            }
        // The regression catch: a fresh host MUST complete the full job —
        // the old world died here as Failed(kind="stamp") with sherpa's
        // "espeak-ng-data dir does not exist".
        assertTrue("fresh-install convert failed: $terminal", terminal is SynthUiState.Done)
        val done = terminal as SynthUiState.Done

        val bundle = File(done.bundlePath)
        assertTrue("bundle missing at ${bundle.absolutePath}", bundle.isFile)
        val book = openBook(bundle.absolutePath)
        assertTrue("the fresh-install book is audible", book.audioPresent)
        assertTrue(book.chapters.isNotEmpty())
        assertNotNull(
            book
                .chapters
                .first()
                .paragraphs
                .first(),
        )

        // The first run actually downloaded into the isolated dirs (the
        // in-job ensure worked; nothing was pre-warmed).
        assertTrue(
            "voice cache must hold the default voice",
            voices.listFiles()!!.any { it.name.endsWith(".onnx") },
        )
        assertTrue("espeak-ng-data must exist in the isolated root", File(espeak, "en_dict").isFile)

        playEveryParagraphToATerminalStop(bundle, book)
        android.util.Log.i(
            "FirstRunTest",
            "fresh-run wall time: ${(System.nanoTime() - t0) / 1_000_000L} ms (two CDN downloads + synth + playback)",
        )
    }

    /** The PlaybackWalkTest walk over the bundle this test just produced. */
    private fun playEveryParagraphToATerminalStop(
        bundle: File,
        book: dev.l1br3.taletrek.ffi.FfiBook,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val targetContext = instrumentation.targetContext
        val expectedKeys = book.chapters.flatMap { ch -> ch.paragraphs.map { p -> p.segmentKey } }

        val walk =
            onMain(instrumentation) {
                val exo = ExoPlayer.Builder(targetContext).build()
                val port = ExoPlayerPort(exo)
                val bridge =
                    PlayerBridge(
                        kernel = TrekKernelPlayer(book),
                        segments = FileSegmentSource(bundle.absolutePath),
                        cache = SegmentCache(File(targetContext.cacheDir, "firstrun-segments")),
                        port = port,
                        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                    )
                port.attach(bridge)
                bridge.userPlay()
                Walk(bridge, port, exo)
            }

        val deadline = System.currentTimeMillis() + 120_000
        var snapshot = onMain(instrumentation) { walk.bridge.snapshot() }
        while (snapshot.status != FfiPlayerStatus.IDLE) {
            assertTrue("playback walk did not finish in time", System.currentTimeMillis() < deadline)
            Thread.sleep(250)
            snapshot = onMain(instrumentation) { walk.bridge.snapshot() }
        }

        val loads = onMain(instrumentation) { walk.port.appliedLoads() }
        assertEquals("every paragraph played, in book order", expectedKeys, loads)
        assertTrue("book end terminal-stops the player", walk.port.stops >= 1)

        onMain(instrumentation) {
            walk.bridge.release()
            walk.exo.release()
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
        val exo: Player,
    )
}
