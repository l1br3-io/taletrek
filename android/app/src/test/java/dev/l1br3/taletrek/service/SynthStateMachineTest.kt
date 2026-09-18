package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.ffi.FfiPipelineConfig
import dev.l1br3.taletrek.ffi.FfiPipelineEvent
import dev.l1br3.taletrek.ffi.FfiPipelineOutcome
import dev.l1br3.taletrek.ffi.FfiPipelinePhase
import dev.l1br3.taletrek.ffi.FfiPipelineState
import dev.l1br3.taletrek.ffi.PipelineObserver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The convert state machine over a fake engine — the JVM half of the spec's
 * testing split (the `.so` never loads here; the real-handle walk is
 * instrumented + on-device). Mirrors PlayerBridgeTest's fake discipline.
 */
class SynthStateMachineTest {
    /** Scriptable fake: records start/cancel, replays events on demand. */
    private class FakeEngine : SynthEngine {
        val starts = mutableListOf<FfiPipelineConfig>()
        var cancelCount = 0
        var observer: PipelineObserver? = null
        var onTerminal: ((FfiPipelineState) -> Unit)? = null
        var started = false

        override fun start(
            config: FfiPipelineConfig,
            observer: PipelineObserver,
            onTerminal: (FfiPipelineState) -> Unit,
        ) {
            starts += config
            this.observer = observer
            this.onTerminal = onTerminal
            started = true
        }

        override fun cancel() {
            cancelCount++
        }

        fun emit(event: FfiPipelineEvent) {
            observer?.onPipelineEvent(event)
        }

        fun terminal(state: FfiPipelineState) {
            onTerminal?.invoke(state)
        }
    }

    private fun outcome(
        bookId: String = "bk_abc",
        textOnly: Boolean = false,
    ) = FfiPipelineOutcome(
        bookId = bookId,
        bundlePath = "/books/$bookId.taletrek",
        textOnly = textOnly,
        chapters = 2u,
        paragraphs = 5u,
        segments = if (textOnly) 0u else 5u,
        sealed = false,
    )

    private fun request() =
        SynthJobRequest(
            sourcePath = "/cache/source.pdf",
            hint = "source.pdf",
            voiceId = null,
            voiceCacheDir = "/files/voices",
            espeakDir = "/files/espeak-ng-data",
            booksDir = "/files/books",
            jobs = 2,
            generatorApp = "taletrek-android",
        )

    @Test
    fun lifecycleMapsPhasesOneToOne() {
        val engine = FakeEngine()
        val controller = SynthController(engine)

        assertTrue(controller.submit(request()))
        assertEquals(SynthUiState.Preparing(null, null), controller.state.value)

        engine.emit(FfiPipelineEvent.Parsed(chapters = 3u, paragraphs = 9u))
        assertEquals(SynthUiState.Preparing(3, 9), controller.state.value)

        engine.emit(FfiPipelineEvent.Phase(FfiPipelinePhase.RESOLVING_VOICE))
        engine.emit(FfiPipelineEvent.DownloadStep(bytesDone = 10uL, bytesTotal = 100uL))
        assertEquals(SynthUiState.DownloadingVoice(10, 100), controller.state.value)

        engine.emit(FfiPipelineEvent.Phase(FfiPipelinePhase.SYNTHESIZING))
        engine.emit(FfiPipelineEvent.SynthStep(done = 2u, total = 9u))
        assertEquals(SynthUiState.Synthesizing(2, 9), controller.state.value)

        engine.emit(FfiPipelineEvent.Phase(FfiPipelinePhase.WRITING))
        assertEquals(SynthUiState.Writing, controller.state.value)

        engine.terminal(FfiPipelineState.Finished(outcome()))
        assertEquals(
            SynthUiState.Done(bookId = "bk_abc", bundlePath = "/books/bk_abc.taletrek"),
            controller.state.value,
        )
    }

    @Test
    fun doubleStartIsRejectedWhileRunning() {
        val engine = FakeEngine()
        val controller = SynthController(engine)
        assertTrue(controller.submit(request()))
        assertFalse(controller.submit(request()))
        assertEquals(1, engine.starts.size)

        engine.terminal(FfiPipelineState.Finished(outcome()))
        assertTrue(controller.submit(request()))
        assertEquals(2, engine.starts.size)
    }

    @Test
    fun cancelReachesTheEngineAndTerminalMapsToCancelled() {
        val engine = FakeEngine()
        val controller = SynthController(engine)
        assertTrue(controller.submit(request()))
        engine.emit(FfiPipelineEvent.Phase(FfiPipelinePhase.SYNTHESIZING))
        controller.cancel()
        assertEquals(1, engine.cancelCount)

        engine.terminal(FfiPipelineState.Cancelled)
        assertEquals(SynthUiState.Cancelled, controller.state.value)
    }

    @Test
    fun failureMapsKindAndMessage() {
        val engine = FakeEngine()
        val controller = SynthController(engine)
        controller.submit(request())
        engine.terminal(FfiPipelineState.Failed(kind = "resolve", message = "network down"))
        assertEquals(SynthUiState.Failed("resolve", "network down"), controller.state.value)
    }

    @Test
    fun submitMapsRequestFieldsIntoTheEngineConfig() {
        val engine = FakeEngine()
        val controller = SynthController(engine)
        assertTrue(controller.submit(request()))
        val config = engine.starts.single()
        assertEquals("/cache/source.pdf", config.sourcePath)
        assertEquals("source.pdf", config.hint)
        assertFalse(config.textOnly)
        assertNull(config.voiceId)
        assertEquals("/files/voices", config.voiceCacheDir)
        assertEquals("/files/espeak-ng-data", config.espeakDir)
        assertEquals("/files/books", config.booksDir)
        assertEquals(2u, config.jobs)
        assertEquals("taletrek-android", config.generatorApp)
    }
}
