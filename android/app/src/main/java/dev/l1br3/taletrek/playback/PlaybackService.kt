package dev.l1br3.taletrek.playback

import android.content.Intent
import android.os.Bundle
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.ffi.openBook
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The Jog core: a Media3 [MediaSessionService] (foreground type
 * `mediaPlayback`, Android 14+ rules) hosting one ExoPlayer. All transport
 * — UI, notification, media buttons — funnels through the [ForwardingPlayer]
 * into the kernel; Media3 never sequences, it reports and obeys. The
 * default media notification (play/pause + chapter-granularity prev/next)
 * comes from Media3.
 */
class PlaybackService : MediaSessionService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private lateinit var exo: ExoPlayer
    private lateinit var exoPort: ExoPlayerPort
    private lateinit var mediaSession: MediaSession

    /** The per-book bridge — null until a book opens. */
    private var bridge: PlayerBridge? = null
    private var openBookId: String? = null
    private var openAudioPresent = false

    override fun onCreate() {
        super.onCreate()
        exo =
            ExoPlayer
                .Builder(this)
                .setAudioAttributes(
                    // GOTCHA: audio-focus handling is OFF for now — Media3's
                    // built-in focus loss pauses the player behind the
                    // kernel's back (state desync). Hardening (008) maps
                    // focus loss to a userPause instead.
                    AudioAttributes.DEFAULT,
                    false,
                ).setWakeMode(C.WAKE_MODE_LOCAL)
                .build()
        exoPort = ExoPlayerPort(exo)
        mediaSession =
            MediaSession
                .Builder(this, KernelForwardingPlayer(exo))
                .setCallback(SessionCallback())
                .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = mediaSession.player
        if (!player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        mediaSession.release()
        bridge?.release()
        bridge = null
        exo.release()
        serviceScope.cancel()
        super.onDestroy()
    }

    /**
     * Everything transport-shaped reaches the kernel here — play/pause and
     * the notification's chapter prev/next included. No sequencing lives in
     * this class: each override is a one-line event dispatch.
     */
    private inner class KernelForwardingPlayer(
        player: Player,
    ) : ForwardingPlayer(player) {
        override fun play() {
            bridge?.userPlay()
        }

        override fun pause() {
            bridge?.userPause()
        }

        override fun seekToNext() {
            bridge?.userNextChapter()
        }

        override fun seekToPrevious() {
            bridge?.userPrevChapter()
        }

        override fun isCommandAvailable(command: Int): Boolean =
            when (command) {
                // Single-item player: Media3 reports these unavailable, but
                // the notification's chapter buttons are the product surface
                // — the kernel honors them from any position.
                Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_PREVIOUS -> true
                else -> super.isCommandAvailable(command)
            }

        override fun getAvailableCommands(): Player.Commands =
            super
                .getAvailableCommands()
                .buildUpon()
                .add(Player.COMMAND_SEEK_TO_NEXT)
                .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                .build()
    }

    private inner class SessionCallback : MediaSession.Callback {
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult {
            val sessionCommands =
                MediaSession.ConnectionResult
                    .DEFAULT_SESSION_AND_LIBRARY_COMMANDS
                    .buildUpon()
                    .apply { SessionCommands.ALL.forEach { add(it) } }
                    .build()
            val accepted =
                MediaSession.ConnectionResult
                    .AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(sessionCommands)
                    .build()
            return accepted
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> =
            when (customCommand.customAction) {
                SessionCommands.ACTION_OPEN_BOOK -> openBookCommand(args.getString(SessionCommands.EXTRA_PATH))
                SessionCommands.ACTION_NEXT_PARAGRAPH -> {
                    bridge?.userNextParagraph()
                    immediateResult
                }
                SessionCommands.ACTION_PREV_PARAGRAPH -> {
                    bridge?.userPrevParagraph()
                    immediateResult
                }
                SessionCommands.ACTION_GET_STATE -> Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS, stateBundle()))
                else -> Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
            }
    }

    private val immediateResult: ListenableFuture<SessionResult> =
        Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))

    private fun openBookCommand(path: String?): ListenableFuture<SessionResult> {
        if (path == null) return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
        // onCustomCommand runs on the main thread; kernel reads are IO.
        check(Looper.myLooper() == Looper.getMainLooper())
        serviceScope.launch {
            runCatching { withContext(Dispatchers.IO) { openBook(path) } }
                .onSuccess { book ->
                    bridge?.release()
                    bridge =
                        PlayerBridge(
                            kernel = TrekKernelPlayer(book),
                            segments = FileSegmentSource(path),
                            cache = SegmentCache(File(cacheDir, "segments")),
                            port = exoPort,
                            scope = serviceScope,
                        ).also { exoPort.attach(it) }
                    openBookId = book.bookId
                    openAudioPresent = book.audioPresent
                }.onFailure {
                    openBookId = null
                    openAudioPresent = false
                }
        }
        return immediateResult
    }

    private fun stateBundle(): Bundle {
        val current = bridge
        val bookId = openBookId
        if (current == null || bookId == null) return SessionCommands.emptyStateBundle()
        val snap = current.snapshot()
        return Bundle().apply {
            putString(
                SessionCommands.STATE_STATUS,
                when (snap.status) {
                    FfiPlayerStatus.IDLE -> "Idle"
                    FfiPlayerStatus.PLAYING -> "Playing"
                    FfiPlayerStatus.PAUSED -> "Paused"
                },
            )
            val para = snap.para
            if (para != null) {
                putLong(SessionCommands.STATE_CHAPTER, para.chapter.toLong())
                putLong(SessionCommands.STATE_INDEX, para.index.toLong())
            } else {
                putLong(SessionCommands.STATE_CHAPTER, -1L)
            }
            putDouble(SessionCommands.STATE_OFFSET, snap.offset)
            putLong(SessionCommands.STATE_SKIPPED, snap.failures.skipped.toLong())
            putString(SessionCommands.STATE_BOOK_ID, bookId)
            putBoolean(SessionCommands.STATE_AUDIO_PRESENT, openAudioPresent)
        }
    }
}
