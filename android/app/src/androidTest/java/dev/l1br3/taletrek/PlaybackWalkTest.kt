package dev.l1br3.taletrek

import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.ffi.openBook
import dev.l1br3.taletrek.playback.ExoPlayerPort
import dev.l1br3.taletrek.playback.FileSegmentSource
import dev.l1br3.taletrek.playback.PlayerBridge
import dev.l1br3.taletrek.playback.SegmentCache
import dev.l1br3.taletrek.playback.TrekKernelPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/**
 * The full stack on a device: the real kernel (via the FFI `.so`), the
 * real bridge discipline, and a real ExoPlayer decoding the playable
 * fixture's OGG/Opus — Play through every drain to the terminal stop.
 * Drives ExoPlayer for real per the task; the fixture's three ~1s
 * segments keep the walk quick.
 */
@RunWith(AndroidJUnit4::class)
class PlaybackWalkTest {
    @Test
    fun playWalksEveryParagraphToATerminalStop() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val bundle =
            File(context.cacheDir, "book-playable.taletrek").apply {
                instrumentation.context.assets.open("book-playable.taletrek").use { input ->
                    outputStream().use { output -> input.copyTo(output) }
                }
            }

        val book = openBook(bundle.absolutePath)
        val expectedKeys = book.chapters.flatMap { ch -> ch.paragraphs.map { p -> p.segmentKey } }

        val walk =
            onMain(instrumentation) {
                val exo = ExoPlayer.Builder(context).build()
                val port = ExoPlayerPort(exo)
                val cache = SegmentCache(File(context.cacheDir, "walk-segments"))
                val bridge =
                    PlayerBridge(
                        kernel = TrekKernelPlayer(book),
                        segments = FileSegmentSource(bundle.absolutePath),
                        cache = cache,
                        port = port,
                        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                    )
                port.attach(bridge)
                bridge.userPlay()
                Walk(bridge, port, exo, cache)
            }

        // The walk: poll (main-thread snapshots) until the machine rests.
        val deadline = System.currentTimeMillis() + 60_000
        var maxResident = 0
        var snapshot = onMain(instrumentation) { walk.bridge.snapshot() }
        while (snapshot.status != FfiPlayerStatus.IDLE) {
            assertTrue("walk did not finish in time", System.currentTimeMillis() < deadline)
            Thread.sleep(250)
            maxResident = maxOf(maxResident, onMain(instrumentation) { walk.cache.residentCount() })
            snapshot = onMain(instrumentation) { walk.bridge.snapshot() }
        }

        val loads = onMain(instrumentation) { walk.port.appliedLoads() }
        assertEquals("every paragraph played, in book order", expectedKeys, loads)
        assertTrue("book end terminal-stops the player", walk.port.stops >= 1)
        assertTrue("at most one segment file resident during the walk", maxResident <= 1)

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
        val cache: SegmentCache,
    )
}
