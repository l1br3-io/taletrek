package dev.l1br3.taletrek.ui.reader

import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.playback.PlaybackService
import dev.l1br3.taletrek.playback.SessionCommands
import dev.l1br3.taletrek.playback.SessionState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The reader's window into playback — open the book in the service,
 * observe its state, forward transport. The seam the JVM tests fake;
 * every method is a one-line forward (UI never sequences).
 */
interface ReaderTransport {
    /** Session state as the kernel authored it (push + initial read). */
    val states: Flow<SessionState>

    fun openBook(path: String)

    fun play()

    fun pause()

    fun nextParagraph()

    fun prevParagraph()

    fun nextChapter()

    fun prevChapter()

    fun seekToParagraph(
        chapter: UInt,
        index: UInt,
    )

    /** Re-aim the live synth job at the playhead (progressive books). */
    fun reanchor(
        chapter: UInt,
        index: UInt,
    )

    /** Re-run the stalled segment load after a resume. */
    fun retryLoad()
}

/**
 * Production transport: owns the app's one [MediaController] (the
 * session listener rides the builder — Media3 has no post-hoc
 * controller-listener attach). Transport rides the session's standard
 * play/pause + chapter commands (they already cross the kernel via
 * the forwarding player — the notification path too); paragraph
 * transport + seeks ride the custom commands; state arrives as
 * STATE_BROADCAST pushes plus one GET_STATE seed read.
 */
class MediaControllerTransport(
    context: Context,
) : ReaderTransport {
    // GOTCHA: must be declared BEFORE controllerFuture — initializers run in
    // declaration order, and buildController() (below) reads appContext while
    // constructing. Declared after, the field is still null and ComponentName
    // NPEs on the very first launch (first surfaced by the emulator suites).
    private val appContext: Context = context.applicationContext

    private var controller: MediaController? = null

    private val _states =
        MutableStateFlow(
            SessionState(
                status = FfiPlayerStatus.IDLE,
                para = null,
                offset = 0.0,
                skipped = 0u,
                lastError = null,
                bookId = null,
                audioPresent = true,
            ),
        )
    override val states = _states.asStateFlow()

    private val controllerFuture: ListenableFuture<MediaController> =
        buildController()

    private fun buildController(): ListenableFuture<MediaController> {
        val future =
            MediaController
                .Builder(
                    // The context outlives the transport only app-wide; the
                    // controller is the app's one session connection.
                    appContext,
                    SessionToken(appContext, ComponentName(appContext, PlaybackService::class.java)),
                ).setListener(
                    object : MediaController.Listener {
                        override fun onCustomCommand(
                            controller: MediaController,
                            customCommand: SessionCommand,
                            extras: Bundle,
                        ): ListenableFuture<SessionResult> {
                            if (customCommand.customAction == SessionCommands.ACTION_STATE_BROADCAST) {
                                _states.value = SessionState.fromBundle(extras)
                            }
                            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                        }
                    },
                ).buildAsync()
        future.addListener(
            {
                runCatching { future.get() }.getOrNull()?.let { ready ->
                    controller = ready
                    // The seed read: what's true right now, before any
                    // push (broadcasts only flow after a transition).
                    val seed = ready.sendCustomCommand(SessionCommands.GET_STATE, Bundle.EMPTY)
                    seed.addListener(
                        {
                            runCatching { seed.get() }.getOrNull()?.extras?.let {
                                _states.value = SessionState.fromBundle(it)
                            }
                        },
                        Runnable::run,
                    )
                }
            },
            Runnable::run,
        )
        return future
    }

    fun release() {
        MediaController.releaseFuture(controllerFuture)
    }

    override fun openBook(path: String) {
        controller?.sendCustomCommand(
            SessionCommands.OPEN_BOOK,
            Bundle().apply { putString(SessionCommands.EXTRA_PATH, path) },
        )
    }

    override fun play() = controller?.play() ?: Unit

    override fun pause() = controller?.pause() ?: Unit

    override fun nextParagraph() {
        controller?.sendCustomCommand(SessionCommands.NEXT_PARAGRAPH, Bundle.EMPTY)
    }

    override fun prevParagraph() {
        controller?.sendCustomCommand(SessionCommands.PREV_PARAGRAPH, Bundle.EMPTY)
    }

    override fun nextChapter() {
        controller?.seekToNext()
    }

    override fun prevChapter() {
        controller?.seekToPrevious()
    }

    override fun seekToParagraph(
        chapter: UInt,
        index: UInt,
    ) {
        controller?.sendCustomCommand(
            SessionCommands.SEEK_PARAGRAPH,
            Bundle().apply {
                putLong(SessionCommands.EXTRA_CHAPTER, chapter.toLong())
                putLong(SessionCommands.EXTRA_INDEX, index.toLong())
            },
        )
    }

    override fun reanchor(
        chapter: UInt,
        index: UInt,
    ) {
        controller?.sendCustomCommand(
            SessionCommands.REANCHOR,
            Bundle().apply {
                putLong(SessionCommands.EXTRA_CHAPTER, chapter.toLong())
                putLong(SessionCommands.EXTRA_INDEX, index.toLong())
            },
        )
    }

    override fun retryLoad() {
        controller?.sendCustomCommand(SessionCommands.RETRY_LOAD, Bundle.EMPTY)
    }
}
