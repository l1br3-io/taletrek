package dev.l1br3.taletrek.playback

import dev.l1br3.taletrek.ffi.FfiSegmentStatus
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The progressive one-shot read mapping — typed statuses to fetch
 * outcomes over a fake FFI read (the `.so` never loads on the JVM; the
 * retry/buffering loop that consumes `NotYet` is PlayerBridge's, tested
 * there).
 */
class ProgressiveSegmentSourceTest {
    private val bytes = "OG OpusHead test".encodeToByteArray()

    @Test
    fun readyCarriesTheBytes() {
        val source = ProgressiveSegmentSource(path = "/books/bk.taletrek", read = { _, _ -> FfiSegmentStatus.Ready(bytes, "opus") })
        assertEquals(SegmentFetch.Bytes(bytes), source.segment("k0"))
    }

    @Test
    fun missingIsAbsentTheSkipPath() {
        val source = ProgressiveSegmentSource(path = "/books/bk.taletrek", read = { _, _ -> FfiSegmentStatus.Missing })
        assertEquals(SegmentFetch.Absent, source.segment("k0"))
    }

    @Test
    fun notReadyIsNotYetTheBufferingPath() {
        val source = ProgressiveSegmentSource(path = "/books/bk.taletrek", read = { _, _ -> FfiSegmentStatus.NotReady })
        assertEquals(SegmentFetch.NotYet, source.segment("k0"))
    }

    @Test
    fun theReadCrossesTheBundlePathAndKey() {
        var seen: Pair<String, String>? = null
        val source =
            ProgressiveSegmentSource(path = "/books/bk.taletrek") { path, key ->
                seen = path to key
                FfiSegmentStatus.Ready(bytes, "opus")
            }
        source.segment("seg-1")
        assertEquals("/books/bk.taletrek" to "seg-1", seen)
    }
}
