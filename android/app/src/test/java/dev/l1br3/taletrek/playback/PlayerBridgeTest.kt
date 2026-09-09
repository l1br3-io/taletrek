package dev.l1br3.taletrek.playback

import dev.l1br3.taletrek.ffi.FfiPlayerAction
import dev.l1br3.taletrek.ffi.FfiPlayerEvent
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.ffi.FfiStateSnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The bridge's event/action discipline over fakes — the JVM half of the
 * spec's testing split (the `.so` does not load here; the walk over the
 * real kernel + real ExoPlayer is instrumented). These mirror the
 * desktop's playback-controller tests: same contract, same cases.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PlayerBridgeTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val kernel = FakeKernel()
    private val port = FakePort()
    private val segments = FakeSegments()
    private lateinit var cache: SegmentCache
    private lateinit var bridge: PlayerBridge

    @Before
    fun setUp() {
        cache = SegmentCache(tmp.newFolder("segments"))
        bridge =
            PlayerBridge(
                kernel = kernel,
                segments = segments,
                cache = cache,
                port = port,
                scope = CoroutineScope(UnconfinedTestDispatcher()),
                ioDispatcher = UnconfinedTestDispatcher(),
            )
    }

    @After
    fun tearDown() {
        runBlocking { bridge.release() }
    }

    @Test
    fun playLoadsTheFirstSegmentAsAFileAtTheOrderedOffset() {
        kernel.script(load("k0", 0.0))
        bridge.userPlay()

        assertEquals(listOf(FfiPlayerEvent.Play), kernel.events)
        assertEquals(listOf("k0"), port.loads.map { it.second })
        val (file, _, offsetMs) = port.loads.single()
        assertTrue(file.readBytes().contentEquals(SEGMENT_BYTES))
        assertEquals(0L, offsetMs)
        assertEquals(1, cache.residentCount())
    }

    @Test
    fun resumeOffsetsCrossAsMilliseconds() {
        kernel.script(load("k0", 2.5))
        bridge.userPlay()
        assertEquals(2500L, port.loads.single().third)
    }

    @Test
    fun anEndedWhileALoadIsPendingIsDroppedAndReadyClosesTheWindow() {
        // Play → load k0 in flight (pending) → ENDED arrives before READY.
        kernel.script(load("k0", 0.0))
        bridge.userPlay()

        bridge.onEnded()
        assertEquals(listOf<FfiPlayerEvent>(FfiPlayerEvent.Play), kernel.events) // drain dropped

        bridge.onReady() // the playhead armed
        bridge.onEnded() // now the drain belongs to the loaded item
        assertEquals(
            listOf(FfiPlayerEvent.Play, FfiPlayerEvent.SegmentDrained("k0")),
            kernel.events,
        )
    }

    @Test
    fun aPlatformErrorMapsToASegmentFailedForThePendingKey() {
        kernel.script(load("k0", 0.0))
        bridge.userPlay()

        bridge.onError(RuntimeException("corrupt opus"))

        assertEquals(
            listOf(
                FfiPlayerEvent.Play,
                FfiPlayerEvent.SegmentFailed("k0", "corrupt opus"),
            ),
            kernel.events,
        )
    }

    @Test
    fun aMissingSegmentIsAKernelSkipNotALoop() {
        segments.keys.remove("k0")
        kernel.script(load("k0", 0.0)) // one load; the kernel absorbs the failure report
        bridge.userPlay()

        val failed = kernel.events.filterIsInstance<FfiPlayerEvent.SegmentFailed>().single()
        assertEquals("k0", failed.key)
        assertTrue(port.loads.isEmpty())
    }

    @Test
    fun aStopActionSilencesOutputAndLeavesNoResidentFile() {
        kernel.script(load("k0", 0.0), FfiPlayerAction.Stop)
        bridge.userPlay()
        assertEquals(1, cache.residentCount())

        bridge.userPause() // the kernel orders Stop for a pause

        assertEquals(1, port.stops)
        assertEquals(0, cache.residentCount())
    }

    @Test
    fun aLoadSupersededMidFlightNeverReachesThePlayer() =
        runTest {
            val scheduler = StandardTestDispatcher(testScheduler)
            val lateBridge =
                PlayerBridge(
                    kernel = kernel,
                    segments = segments,
                    cache = cache,
                    port = port,
                    scope = CoroutineScope(scheduler),
                    ioDispatcher = scheduler,
                )
            kernel.script(load("k0", 0.0), load("k1", 0.0))
            lateBridge.userPlay() // k0's load queued, not yet executed
            lateBridge.userNextParagraph() // supersedes it before it runs

            advanceUntilIdle()

            assertEquals(listOf("k1"), port.loads.map { it.second })
            assertEquals(1, cache.residentCount())
        }

    @Test
    fun releaseStopsDropsTheCacheAndClosesTheKernel() {
        kernel.script(load("k0", 0.0))
        bridge.userPlay()
        bridge.release()
        assertEquals(1, port.stops)
        assertEquals(0, cache.residentCount())
        assertTrue(kernel.closed)
    }

    // --- fakes -------------------------------------------------------------

    private companion object {
        val SEGMENT_BYTES = "OG OpusHead test".encodeToByteArray()
    }

    /**
     * Scripted kernel: queued actions (popped per tick, `None` when dry),
     * every received event recorded — a faithful-enough stand-in for the
     * kernel's one-action-per-event contract.
     */
    private class FakeKernel : KernelPlayer {
        private val actions = ArrayDeque<FfiPlayerAction>()
        val events = mutableListOf<FfiPlayerEvent>()
        var closed = false

        fun script(vararg next: FfiPlayerAction) {
            next.forEach { actions.add(it) }
        }

        override fun tick(event: FfiPlayerEvent): FfiPlayerAction {
            events.add(event)
            return actions.removeFirstOrNull() ?: FfiPlayerAction.None
        }

        override fun snapshot(): FfiStateSnapshot =
            FfiStateSnapshot(
                status = FfiPlayerStatus.IDLE,
                para = null,
                offset = 0.0,
                failures =
                    dev.l1br3.taletrek.ffi
                        .FfiFailureLog(0u, null),
            )

        override fun position() = null

        override fun close() {
            closed = true
        }
    }

    private class FakeSegments : SegmentSource {
        val keys = mutableSetOf("k0", "k1")

        override fun segment(key: String): ByteArray? = if (key in keys) SEGMENT_BYTES else null
    }

    private class FakePort : AudioPort {
        val loads = mutableListOf<Triple<File, String, Long>>()
        var stops = 0

        override fun load(
            file: File,
            mediaId: String,
            offsetMs: Long,
        ) {
            loads.add(Triple(file, mediaId, offsetMs))
        }

        override fun stopOutput() {
            stops++
        }
    }
}

private fun load(
    key: String,
    offset: Double,
): FfiPlayerAction.LoadSegment = FfiPlayerAction.LoadSegment(key, offset)
