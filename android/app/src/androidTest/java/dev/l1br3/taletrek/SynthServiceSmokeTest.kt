package dev.l1br3.taletrek

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.l1br3.taletrek.ffi.FfiPipelineConfig
import dev.l1br3.taletrek.ffi.FfiPipelineEvent
import dev.l1br3.taletrek.ffi.FfiPipelineOutcome
import dev.l1br3.taletrek.ffi.FfiPipelinePhase
import dev.l1br3.taletrek.ffi.FfiPipelineState
import dev.l1br3.taletrek.ffi.PipelineObserver
import dev.l1br3.taletrek.service.SynthEngine
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Service smoke with a scripted fake engine (task 005): foreground
 * promotion, the event → [SynthService.active] relay, cancel-by-intent,
 * and clean teardown — against the real Service/NotificationManager
 * machinery on device. The real-handle pipeline walk is task 008's e2e.
 */
@RunWith(AndroidJUnit4::class)
class SynthServiceSmokeTest {
    @After
    fun resetSeam() {
        // Explicit teardown: a stopped record can't wedge a later test's
        // start (the service's own linger is a production nicety, not a
        // test contract).
        ApplicationProvider.getApplicationContext<android.content.Context>().let {
            it.stopService(android.content.Intent(it, SynthService::class.java))
        }
        SynthService.seamOverride = null
    }

    /**
     * Await THIS run's outcome, never a stale terminal: observe a change
     * from the snapshot first (a fresh controller resets the slot to
     * null), then the target. Guard borrowed from the matrix test.
     */
    private suspend fun awaitFresh(target: (SynthUiState?) -> Boolean): SynthUiState {
        val before = SynthService.active.value
        withTimeout(20_000) {
            SynthService.active.first { it != before }
        }
        return withTimeout(30_000) {
            SynthService.active.first { target(it) && it != null }!!
        }
    }

    /** Emits a scripted lifecycle (paragraph steps over ~1 s), then a
     *  terminal state — Cancelled when the controller cancels mid-run. */
    private class ScriptedEngine(
        private val terminal: FfiPipelineState,
    ) : SynthEngine {
        private val started = CountDownLatch(1)
        private val cancelled = AtomicBoolean(false)

        override fun start(
            config: FfiPipelineConfig,
            observer: PipelineObserver,
            onTerminal: (FfiPipelineState) -> Unit,
        ) {
            started.countDown()
            Thread(
                {
                    observer.onPipelineEvent(FfiPipelineEvent.Phase(FfiPipelinePhase.PARSING))
                    observer.onPipelineEvent(FfiPipelineEvent.Parsed(chapters = 2u, paragraphs = 6u))
                    observer.onPipelineEvent(FfiPipelineEvent.Phase(FfiPipelinePhase.SYNTHESIZING))
                    for (done in 1..50) {
                        if (cancelled.get()) break
                        observer.onPipelineEvent(FfiPipelineEvent.SynthStep(done.toUInt(), 50u))
                        Thread.sleep(20)
                    }
                    onTerminal(if (cancelled.get()) FfiPipelineState.Cancelled else terminal)
                },
                "scripted-engine",
            ).apply { isDaemon = true }.start()
        }

        override fun cancel() {
            cancelled.set(true)
        }

        override fun reanchor(anchor: dev.l1br3.taletrek.ffi.FfiAnchor) {}

        fun awaitStart() = started.await(5, TimeUnit.SECONDS)
    }

    private fun request() =
        SynthJobRequest(
            sourcePath = "/cache/fake-source.txt",
            hint = "fake-source.txt",
            voiceId = null,
            voiceCacheDir = "/files/voices",
            espeakDir = "/files/espeak",
            booksDir = "/files/books",
            storeDir = "/cache/taletrek/segments",
            jobs = 2,
            generatorApp = "taletrek-android",
        )

    private fun startService(engine: ScriptedEngine) {
        SynthService.seamOverride = engine
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.startForegroundService(request().toIntent(context))
        assertTrue("engine never started — service died?", engine.awaitStart())
    }

    @Test
    fun jobRunsToDoneAndTheRelayCarriesEveryPhase() =
        runBlocking {
            val engine =
                ScriptedEngine(
                    FfiPipelineState.Finished(
                        FfiPipelineOutcome(
                            bookId = "bk_smoke",
                            bundlePath = "/files/books/bk_smoke.taletrek",
                            textOnly = false,
                            chapters = 2u,
                            paragraphs = 6u,
                            segments = 6u,
                            sealed = false,
                        ),
                    ),
                )
            // Collect on a real thread — runBlocking's thread is busy in
            // startService, and StateFlow conflation would eat the early
            // phases before a same-thread collector gets scheduled.
            val seen = java.util.Collections.synchronizedList(mutableListOf<SynthUiState?>())
            val scope = CoroutineScope(Dispatchers.Default + Job())
            val recorder =
                scope.launch {
                    SynthService.active.collect { seen += it }
                }
            try {
                startService(engine)
                val done = awaitFresh { it is SynthUiState.Done }
                assertEquals(
                    SynthUiState.Done(
                        bookId = "bk_smoke",
                        bundlePath = "/files/books/bk_smoke.taletrek",
                    ),
                    done,
                )
                assertTrue(
                    "relay missed every running-phase state: $seen",
                    // Exact 1:1 mapping is JVM-tested; the relay crosses two
                    // conflating StateFlows (controller → active), so fast
                    // phase bursts may collapse — the smoke asserts a
                    // running phase reached collectors before Done.
                    seen.any { it is SynthUiState.Preparing || it is SynthUiState.Synthesizing },
                )
            } finally {
                recorder.cancel()
                scope.cancel()
            }
        }

    @Test
    fun cancelIntentStopsTheJobAndLandsCancelled() =
        runBlocking {
            val engine = ScriptedEngine(FfiPipelineState.Finished(FfiPipelineOutcome("x", "x", true, 1u, 1u, 1u, false)))
            startService(engine)
            awaitFresh { it is SynthUiState.Synthesizing }
            val context = ApplicationProvider.getApplicationContext<android.content.Context>()
            context.startService(
                android.content
                    .Intent(context, SynthService::class.java)
                    .setAction(SynthService.ACTION_CANCEL),
            )
            val terminal = awaitFresh { it is SynthUiState.Cancelled }
            assertEquals(SynthUiState.Cancelled, terminal)
        }
}
