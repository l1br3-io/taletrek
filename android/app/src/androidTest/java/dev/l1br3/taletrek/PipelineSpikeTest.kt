package dev.l1br3.taletrek

import android.os.Looper
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.ffi.SpikeObserver
import dev.l1br3.taletrek.ffi.spikeDownloadVoice
import dev.l1br3.taletrek.ffi.spikeFetchEspeak
import dev.l1br3.taletrek.ffi.spikeSynthParagraph
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * android-pipeline task 002 THROWAWAY spike: proves CDN voice download
 * (ureq/rustls over JNI), espeak-ng-data fetch, one-paragraph sherpa synth,
 * and UniFFI callbacks delivered from a rayon worker thread — on-device.
 * Deleted with the spike shims in task 004.
 */
@RunWith(AndroidJUnit4::class)
class PipelineSpikeTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val files get() = instrumentation.targetContext.filesDir

    private val noObserver =
        object : SpikeObserver {
            override fun onEvent(event: String) {}
        }

    /** Latching observer: records event names + the thread each arrived on. */
    private class RecordingObserver : SpikeObserver {
        val events = mutableListOf<String>()
        val threads = mutableSetOf<Thread>()
        val done = CountDownLatch(1)

        override fun onEvent(event: String) {
            synchronized(events) {
                events.add(event)
                threads.add(Thread.currentThread())
            }
            if (
                event == "download-end" ||
                event == "espeak-done" ||
                event == "espeak-cache-hit" ||
                event == "synth-predict-end"
            ) {
                done.countDown()
            }
        }

        fun await(): List<String> {
            assertTrue("timed out waiting for terminal event", done.await(10, TimeUnit.MINUTES))
            return synchronized(events) { events.toList() }
        }
    }

    @Test
    fun voiceDownloadsFromRealCdnThenCacheHits() {
        val voices = File(files, "voices")
        // Cold-start guarantee: another test may already have warmed the cache.
        voices.deleteRecursively()

        val firstObserver = RecordingObserver()
        val firstPath = spikeDownloadVoice(voices.absolutePath, firstObserver)
        val firstEvents = firstObserver.await()
        val onnx = File(firstPath)
        assertTrue("onnx missing: $firstPath", onnx.isFile)
        assertTrue(
            "json sibling missing",
            File(onnx.parentFile, "${onnx.nameWithoutExtension}.json").isFile,
        )
        assertTrue(
            "expected download progress events: $firstEvents",
            firstEvents.any { it.startsWith("download-step") },
        )

        val secondObserver = RecordingObserver()
        val secondPath = spikeDownloadVoice(voices.absolutePath, secondObserver)
        val secondEvents = secondObserver.await()
        assertEquals("re-resolve must return the same path", firstPath, secondPath)
        assertFalse(
            "warm cache must not re-download: $secondEvents",
            secondEvents.any { it.startsWith("download-step") },
        )
    }

    @Test
    fun espeakDataFetchesUnzipsAndCacheHits() {
        // Cold-start guarantee: another test may already have warmed the cache.
        File(files, "espeak-ng-data").deleteRecursively()

        val firstObserver = RecordingObserver()
        val firstDir = spikeFetchEspeak(files.absolutePath, firstObserver)
        val firstEvents = firstObserver.await()
        assertTrue(File(firstDir, "en_dict").isFile)
        assertFalse("first run must not hit the cache", firstEvents.contains("espeak-cache-hit"))

        val secondObserver = RecordingObserver()
        val secondDir = spikeFetchEspeak(files.absolutePath, secondObserver)
        val secondEvents = secondObserver.await()
        assertEquals(firstDir, secondDir)
        assertTrue("second run must hit the cache", secondEvents.contains("espeak-cache-hit"))
    }

    @Test
    fun synthesizesOneParagraphOnDeviceWithRayonCallback() {
        val voice = spikeDownloadVoice(File(files, "voices").absolutePath, noObserver)
        val espeak = spikeFetchEspeak(files.absolutePath, noObserver)

        val observer = RecordingObserver()
        val outcome =
            spikeSynthParagraph(
                voice,
                espeak,
                "The quick brown fox jumps over the lazy dog, twice, so the synthesizer has something to chew on.",
                observer,
            )
        val events = observer.await()

        assertTrue("wav suspiciously small: ${outcome.wavBytes}", outcome.wavBytes > 10_000uL)
        assertTrue("audio too short: ${outcome.audioSeconds}s", outcome.audioSeconds > 0.5)
        assertTrue("no load event", events.contains("synth-load-start"))
        assertTrue("no predict events", events.contains("synth-predict-start"))
        val mainThread = Looper.getMainLooper().thread
        assertFalse(
            "callbacks all arrived on the main thread — callback verdict would be POLL",
            observer.threads.all { it === mainThread },
        )
        Log.i(
            "PipelineSpike",
            "throughput: load ${outcome.loadMs} ms, synth ${outcome.synthMs} ms, " +
                "audio ${outcome.audioSeconds}s from ${outcome.wavBytes} wav bytes",
        )
    }
}
