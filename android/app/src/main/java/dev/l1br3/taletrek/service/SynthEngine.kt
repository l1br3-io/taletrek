package dev.l1br3.taletrek.service

import android.content.Context
import android.content.Intent
import dev.l1br3.taletrek.ffi.FfiAnchor
import dev.l1br3.taletrek.ffi.FfiPipelineConfig
import dev.l1br3.taletrek.ffi.FfiPipelineEvent
import dev.l1br3.taletrek.ffi.FfiPipelinePhase
import dev.l1br3.taletrek.ffi.FfiPipelineSetupException
import dev.l1br3.taletrek.ffi.FfiPipelineState
import dev.l1br3.taletrek.ffi.FfiProgressiveConfig
import dev.l1br3.taletrek.ffi.PipelineHandle
import dev.l1br3.taletrek.ffi.PipelineObserver
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The pipeline engine seam — everything the controller needs from the
 * kernel handle, shaped so the JVM tests drive fakes (the `.so` never
 * loads on the JVM; the real engine only runs on device).
 */
interface SynthEngine {
    /** Start one job; `onTerminal` fires exactly once with the end state. */
    fun start(
        config: FfiPipelineConfig,
        observer: PipelineObserver,
        onTerminal: (FfiPipelineState) -> Unit,
    )

    /** Request cancellation (no-op when idle). */
    fun cancel()
}

/**
 * Runner count for an on-device full synth. Each sherpa runner holds its
 * model plus an onnxruntime arena that is sized by the largest chunk it has
 * ever synthesized and never shrinks — ≈300–420 MB steady-state per runner
 * (the kernel caps chunks at 120 chars to keep it there). Two runners on a
 * ≤3 GB device (emulators, entry-level phones) alongside GMS is an LMK kill
 * mid-convert; constrained devices serialize instead.
 */
fun pipelineJobsForDevice(
    totalMemBytes: Long,
    isLowRamDevice: Boolean,
): Int = if (isLowRamDevice || totalMemBytes < LOW_RAM_DEVICE_FLOOR_BYTES) 1 else DEFAULT_PIPELINE_JOBS

/** Above this much RAM, both runners fit. */
const val LOW_RAM_DEVICE_FLOOR_BYTES: Long = 3L shl 30

/** The unconstrained default (one runner per pool chunk). */
const val DEFAULT_PIPELINE_JOBS: Int = 2

/**
 * [SynthEngine] over the real [PipelineHandle]. Events stream live through
 * the observer (worker threads — dispatch is the caller's job); the
 * terminal state is polled off-thread because the FFI event stream has no
 * terminal event by design (state is the poll API, task 004). Setup
 * failures ([FfiPipelineSetupException] — unreadable source, double
 * start) surface as a `setup` Failed terminal instead of an app crash.
 */
class HandleSynthEngine(
    private val makeHandle: (FfiPipelineConfig) -> PipelineHandle,
) : SynthEngine {
    @Volatile
    private var handle: PipelineHandle? = null

    override fun start(
        config: FfiPipelineConfig,
        observer: PipelineObserver,
        onTerminal: (FfiPipelineState) -> Unit,
    ) {
        val h = makeHandle(config)
        handle = h
        try {
            h.start(observer)
        } catch (e: FfiPipelineSetupException) {
            onTerminal(FfiPipelineState.Failed(kind = "setup", message = e.setupMessage()))
            return
        }
        Thread(
            {
                while (!Thread.currentThread().isInterrupted) {
                    when (val s = h.state()) {
                        is FfiPipelineState.Finished, is FfiPipelineState.Failed,
                        is FfiPipelineState.Cancelled,
                        -> {
                            onTerminal(s)
                            return@Thread
                        }
                        else -> {}
                    }
                    Thread.sleep(POLL_MS)
                }
            },
            "synth-terminal-poll",
        ).apply { isDaemon = true }.start()
    }

    private fun FfiPipelineSetupException.setupMessage(): String =
        when (this) {
            is FfiPipelineSetupException.ReadSource -> "reading source $path: $detail"
            is FfiPipelineSetupException.AlreadyStarted -> "pipeline already started"
        }

    override fun cancel() {
        handle?.cancel()
    }

    private companion object {
        const val POLL_MS = 150L
    }
}

/** One convert request, carried across the service intent. Android
 *  submits the progressive variant: the text bundle lands immediately
 *  and audio fills the segment store while the book is listenable. */
data class SynthJobRequest(
    val sourcePath: String,
    val hint: String?,
    val voiceId: String?,
    val voiceCacheDir: String,
    val espeakDir: String,
    val booksDir: String,
    val storeDir: String,
    val jobs: Int,
    val generatorApp: String,
    val initialAnchor: FfiAnchor? = null,
) {
    fun toIntent(context: Context): Intent =
        Intent(context, SynthService::class.java).apply {
            action = SynthService.ACTION_START
            putExtra(EXTRA_SOURCE, sourcePath)
            putExtra(EXTRA_HINT, hint)
            putExtra(EXTRA_VOICE, voiceId)
            putExtra(EXTRA_VOICE_CACHE, voiceCacheDir)
            putExtra(EXTRA_ESPEAK, espeakDir)
            putExtra(EXTRA_BOOKS, booksDir)
            putExtra(EXTRA_STORE, storeDir)
            putExtra(EXTRA_JOBS, jobs)
            putExtra(EXTRA_GENERATOR, generatorApp)
            putExtra(EXTRA_ANCHOR_CH, initialAnchor?.chapter?.toInt() ?: -1)
            putExtra(EXTRA_ANCHOR_P, initialAnchor?.paragraph?.toInt() ?: -1)
        }

    companion object {
        const val EXTRA_SOURCE = "dev.l1br3.taletrek.synth.source"
        const val EXTRA_HINT = "dev.l1br3.taletrek.synth.hint"
        const val EXTRA_VOICE = "dev.l1br3.taletrek.synth.voice"
        const val EXTRA_VOICE_CACHE = "dev.l1br3.taletrek.synth.voiceCache"
        const val EXTRA_ESPEAK = "dev.l1br3.taletrek.synth.espeak"
        const val EXTRA_BOOKS = "dev.l1br3.taletrek.synth.books"
        const val EXTRA_STORE = "dev.l1br3.taletrek.synth.store"
        const val EXTRA_JOBS = "dev.l1br3.taletrek.synth.jobs"
        const val EXTRA_GENERATOR = "dev.l1br3.taletrek.synth.generator"
        const val EXTRA_ANCHOR_CH = "dev.l1br3.taletrek.synth.anchorChapter"
        const val EXTRA_ANCHOR_P = "dev.l1br3.taletrek.synth.anchorParagraph"

        /** Inverse of [toIntent] — null when the intent carries no job. */
        fun fromIntent(intent: Intent): SynthJobRequest? {
            if (intent.action != SynthService.ACTION_START) return null
            val source = intent.getStringExtra(EXTRA_SOURCE) ?: return null
            val anchorCh = intent.getIntExtra(EXTRA_ANCHOR_CH, -1)
            val anchorP = intent.getIntExtra(EXTRA_ANCHOR_P, -1)
            return SynthJobRequest(
                sourcePath = source,
                hint = intent.getStringExtra(EXTRA_HINT),
                voiceId = intent.getStringExtra(EXTRA_VOICE),
                voiceCacheDir = intent.getStringExtra(EXTRA_VOICE_CACHE) ?: return null,
                espeakDir = intent.getStringExtra(EXTRA_ESPEAK) ?: return null,
                booksDir = intent.getStringExtra(EXTRA_BOOKS) ?: return null,
                storeDir = intent.getStringExtra(EXTRA_STORE) ?: return null,
                jobs = intent.getIntExtra(EXTRA_JOBS, 2),
                generatorApp = intent.getStringExtra(EXTRA_GENERATOR) ?: "taletrek-android",
                initialAnchor =
                    if (anchorCh >= 0 && anchorP >= 0) {
                        FfiAnchor(anchorCh.toUInt(), anchorP.toUInt())
                    } else {
                        null
                    },
            )
        }
    }
}

/** Progress as the UI + notification render it — derived, never stored raw. */
sealed interface SynthUiState {
    /** No job has ever run in this process. */
    data object Idle : SynthUiState

    /** Parsing the document (indeterminate phase). */
    data class Preparing(
        val chapters: Int?,
        val paragraphs: Int?,
    ) : SynthUiState

    /** Downloading the voice (bytes of total; total 0 = unknown). */
    data class DownloadingVoice(
        val done: Long,
        val total: Long,
    ) : SynthUiState

    /** Synthesizing (paragraphs done of total). */
    data class Synthesizing(
        val done: Int,
        val total: Int,
    ) : SynthUiState

    /** Synthesizing with listening already possible — audio runs ahead
     *  of the playhead (progressive `Playable`). */
    data class Filling(
        val done: Int,
        val total: Int,
    ) : SynthUiState

    /** Serializing + writing the bundle (brief tail phase). */
    data object Writing : SynthUiState

    /** Finished: the outcome of a successful run. */
    data class Done(
        val bookId: String,
        val bundlePath: String,
    ) : SynthUiState

    /** Failed: stable kernel error kind + human message. */
    data class Failed(
        val kind: String,
        val message: String,
    ) : SynthUiState

    /** Cancelled by the user; no partial book exists. */
    data object Cancelled : SynthUiState
}

/**
 * The convert state machine — pure Kotlin over [SynthEngine]; the service
 * hosts it, the UI (006) collects [state]. One job at a time: a submit
 * while running returns `false` (the caller surfaces "already
 * converting").
 *
 * Events arrive on whatever thread the engine calls from — the controller
 * serializes through the [MutableStateFlow] (thread-safe by contract) and
 * keeps everything else immutable.
 */
class SynthController(
    private val engine: SynthEngine,
) {
    private val _state = MutableStateFlow<SynthUiState>(SynthUiState.Idle)
    val state = _state.asStateFlow()

    private var playable = false
    private var stepDone = 0
    private var stepTotal = 0

    /** Submit one job; `false` when a job is already running. */
    @Synchronized
    fun submit(request: SynthJobRequest): Boolean {
        if (_state.value.isRunningPhase) return false
        playable = false
        stepDone = 0
        stepTotal = 0
        _state.value = SynthUiState.Preparing(chapters = null, paragraphs = null)
        engine.start(request.toConfig(), observer) { terminal ->
            _state.value = terminal.toUi()
        }
        return true
    }

    /** Request cancel; no-op when not running. */
    fun cancel() = engine.cancel()

    /** Whether a job is currently running (any pre-terminal state). */
    fun isRunning(): Boolean = _state.value.isRunningPhase

    private val observer =
        object : PipelineObserver {
            override fun onPipelineEvent(event: FfiPipelineEvent) {
                _state.value =
                    when (event) {
                        is FfiPipelineEvent.Phase ->
                            when (event.v1) {
                                FfiPipelinePhase.PARSING -> SynthUiState.Preparing(null, null)
                                FfiPipelinePhase.RESOLVING_VOICE -> SynthUiState.Preparing(null, null)
                                FfiPipelinePhase.SYNTHESIZING ->
                                    if (playable) {
                                        _state.value
                                    } else {
                                        SynthUiState.Synthesizing(0, 0)
                                    }
                                FfiPipelinePhase.WRITING -> SynthUiState.Writing
                                // Progressive seal: the merged bundle is
                                // landing — product wiring lands with the
                                // progressive Android tasks.
                                FfiPipelinePhase.SEALING -> SynthUiState.Writing
                            }
                        is FfiPipelineEvent.Parsed ->
                            SynthUiState.Preparing(event.`chapters`.toInt(), event.`paragraphs`.toInt())
                        is FfiPipelineEvent.DownloadStep ->
                            SynthUiState.DownloadingVoice(event.`bytesDone`.toLong(), event.`bytesTotal`.toLong())
                        is FfiPipelineEvent.SynthStep -> {
                            stepDone = event.`done`.toInt()
                            stepTotal = event.`total`.toInt()
                            if (playable) {
                                SynthUiState.Filling(stepDone, stepTotal)
                            } else {
                                SynthUiState.Synthesizing(stepDone, stepTotal)
                            }
                        }
                        // Progressive lifecycle: listening is possible from
                        // here on — the rest of the run renders as filling.
                        FfiPipelineEvent.Playable -> {
                            playable = true
                            SynthUiState.Filling(stepDone, stepTotal)
                        }
                        FfiPipelineEvent.Sealed -> SynthUiState.Writing
                    }
            }
        }

    private fun FfiPipelineState.toUi(): SynthUiState =
        when (this) {
            is FfiPipelineState.Finished ->
                SynthUiState.Done(
                    bookId = v1.`bookId`,
                    bundlePath = v1.`bundlePath`,
                )
            is FfiPipelineState.Failed -> SynthUiState.Failed(`kind`, `message`)
            FfiPipelineState.Cancelled -> SynthUiState.Cancelled
            FfiPipelineState.Idle -> SynthUiState.Idle
            FfiPipelineState.Running -> SynthUiState.Preparing(null, null)
        }
}

/** Whether the state is a pre-terminal phase — a job owns the single slot.
 *  Public seam for the import flow's converting guard. */
val SynthUiState.isRunningPhase: Boolean
    get() =
        this is SynthUiState.Preparing ||
            this is SynthUiState.DownloadingVoice ||
            this is SynthUiState.Synthesizing ||
            this is SynthUiState.Filling ||
            this is SynthUiState.Writing

private fun SynthJobRequest.toConfig() =
    FfiPipelineConfig(
        sourcePath = sourcePath,
        hint = hint,
        // Android only ever converts to audio — the text-only variant is a
        // kernel/FFI capability (desktop/web bundles), never sent from here.
        textOnly = false,
        voiceId = voiceId,
        voiceCacheDir = voiceCacheDir,
        espeakDir = espeakDir,
        booksDir = booksDir,
        jobs = jobs.toUInt(),
        generatorApp = generatorApp,
        // Every import converts progressively: text bundle first, audio
        // fills the store while the book is listenable, drain seals.
        progressive =
            FfiProgressiveConfig(
                storeDir = storeDir,
                initialAnchor = initialAnchor,
            ),
    )
