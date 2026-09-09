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
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * The corrupt-segment walk on device, for real: one `audio/` entry
 * truncated inside an otherwise-valid copy of the playable fixture —
 * the zip reads fine, the OGG doesn't. The whole `SegmentFailed` path
 * exercised end-to-end: the paragraph is skipped, `FailureLog` counts
 * it, the book plays through to its terminal stop, and the temp-file
 * cache stays bounded.
 */
@RunWith(AndroidJUnit4::class)
class CorruptWalkTest {
    @Test
    fun aTruncatedSegmentIsSkippedCountedAndTheWalkContinues() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val source =
            File(context.cacheDir, "corrupt-source.taletrek").apply {
                instrumentation.context.assets.open("book-playable.taletrek").use { input ->
                    outputStream().use { output -> input.copyTo(output) }
                }
            }
        val bundle = File(context.cacheDir, "corrupt-${System.nanoTime()}.taletrek")
        val corruptKey = truncatedFirstAudioEntry(source, bundle)

        val book = openBook(bundle.absolutePath)
        val expectedKeys =
            book.chapters
                .flatMap { ch -> ch.paragraphs.map { p -> p.segmentKey } }
                .filter { it != corruptKey }

        val walk =
            onMain(instrumentation) {
                val exo = ExoPlayer.Builder(context).build()
                val port = ExoPlayerPort(exo)
                val cache = SegmentCache(File(context.cacheDir, "corrupt-segments"))
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
        assertEquals("the readable paragraphs played, in book order", expectedKeys, loads)
        assertEquals("the truncated segment is counted exactly once", 1u, snapshot.failures.skipped)
        assertTrue("book end terminal-stops the player", walk.port.stops >= 1)
        assertTrue("at most one segment file resident during the walk", maxResident <= 1)

        onMain(instrumentation) {
            walk.bridge.release()
            walk.exo.release()
        }
    }

    /**
     * Rewrite the bundle with the first `audio/` entry truncated to
     * half its bytes — a valid zip entry whose OGG payload is cut
     * short (decode fails, the archive itself doesn't). Returns the
     * corrupted entry's name (the segment key).
     */
    private fun truncatedFirstAudioEntry(
        source: File,
        dest: File,
    ): String {
        ZipFile(source).use { zip ->
            val entries = zip.entries().toList()
            val corrupt = entries.first { it.name.startsWith("audio/") }
            ZipOutputStream(dest.outputStream()).use { out ->
                for (entry in entries) {
                    out.putNextEntry(ZipEntry(entry.name))
                    zip.getInputStream(entry).use { input ->
                        if (entry.name == corrupt.name) {
                            val bytes = input.readBytes()
                            out.write(bytes, 0, maxOf(1, bytes.size / 2))
                        } else {
                            input.copyTo(out)
                        }
                    }
                    out.closeEntry()
                }
            }
            return corrupt.name
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
