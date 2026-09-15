package dev.l1br3.taletrek.playback

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Bundle
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import dev.l1br3.taletrek.R
import dev.l1br3.taletrek.data.BookSession
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.ffi.FfiPosition
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
    private val audioManager: AudioManager by lazy { getSystemService(AudioManager::class.java) }
    private lateinit var exoPort: ExoPlayerPort
    private lateinit var mediaSession: MediaSession

    /** The per-book bridge — null until a book opens. */
    private var bridge: PlayerBridge? = null
    private var openBookId: String? = null
    private var openAudioPresent = false

    private lateinit var positionStore: PositionStore

    override fun onCreate() {
        super.onCreate()
        positionStore = PositionStore.fromContext(this)
        exo =
            ExoPlayer
                .Builder(this)
                .setAudioAttributes(
                    // Built-in focus handling stays OFF on purpose: Media3's
                    // would pause the player behind the kernel's back (state
                    // desync). Interruption is owned here instead — the
                    // AudioFocusPolicy + NoisyAudioRouter pair below, every
                    // outcome a kernel-routed userPause.
                    AudioAttributes.DEFAULT,
                    false,
                ).setWakeMode(C.WAKE_MODE_LOCAL)
                .build()
        exoPort = ExoPlayerPort(exo)
        mediaSession =
            MediaSession
                .Builder(this, KernelForwardingPlayer(exo))
                .setCallback(SessionCallback())
                // The notification's chapter actions (spec: chapter
                // granularity, no seekbar) — the default provider also
                // keeps its own play/pause. The player commands cross the
                // forwarding player into the kernel like every other
                // transport surface.
                .setCustomLayout(
                    listOf(
                        CommandButton
                            .Builder()
                            .setDisplayName("Previous chapter")
                            .setIconResId(R.drawable.ic_chapter_previous)
                            .setPlayerCommand(Player.COMMAND_SEEK_TO_PREVIOUS)
                            .build(),
                        CommandButton
                            .Builder()
                            .setDisplayName("Next chapter")
                            .setIconResId(R.drawable.ic_chapter_next)
                            .setPlayerCommand(Player.COMMAND_SEEK_TO_NEXT)
                            .build(),
                    ),
                ).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = mediaSession.player
        if (!player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        if (focusHeld) abandonFocus()
        noisyRouter.release() // before the bridge dies — never a dangling receiver
        mediaSession.release()
        persistOnce() // best-effort final write (transport events did the rest)
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
                SessionCommands.ACTION_SEEK_PARAGRAPH -> {
                    bridge?.userSeekToParagraph(
                        args.getLong(SessionCommands.EXTRA_CHAPTER).toUInt(),
                        args.getLong(SessionCommands.EXTRA_INDEX).toUInt(),
                    )
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
            runCatching { withContext(Dispatchers.IO) { BookSession.open(this@PlaybackService, path, positionStore) } }
                .onSuccess { session ->
                    bridge?.release()
                    bridge =
                        PlayerBridge(
                            kernel = session.kernel,
                            segments = FileSegmentSource(path),
                            cache = SegmentCache(File(cacheDir, "segments")),
                            port = exoPort,
                            scope = serviceScope,
                            onPositionChanged = { pos -> persist(session.book.bookId, pos) },
                            onSnapshotChanged = { snap ->
                                broadcastSnapshot(session.book.bookId, session.book.audioPresent, snap)
                            },
                        ).also { exoPort.attach(it) }
                    openBookId = session.book.bookId
                    openAudioPresent = session.book.audioPresent
                }.onFailure {
                    openBookId = null
                    openAudioPresent = false
                }
        }
        return immediateResult
    }

    /**
     * One kernel transition, pushed to every connected controller —
     * the reader's highlight + transport ride this (the T3 poll's
     * replacement). Also the single point where audio focus and the
     * becoming-noisy receiver track playback state (playing holds
     * them; anything else releases them).
     */
    private fun broadcastSnapshot(
        bookId: String,
        audioPresent: Boolean,
        snap: dev.l1br3.taletrek.ffi.FfiStateSnapshot,
    ) {
        runCatching {
            mediaSession.broadcastCustomCommand(
                SessionCommands.STATE_BROADCAST,
                snapshotBundle(bookId, audioPresent, snap),
            )
        }
        syncAudioFocus(snap.status)
        noisyRouter.sync(snap.status)
    }

    // --- audio focus + becoming-noisy (the interruption pair) -------------

    private val focusListener =
        AudioManager.OnAudioFocusChangeListener { change ->
            when (AudioFocusPolicy.onFocusChange(change)) {
                AudioFocusPolicy.Response.Pause -> bridge?.userPause()
                AudioFocusPolicy.Response.Duck -> exo.volume = DUCK_VOLUME
                AudioFocusPolicy.Response.RestoreVolume -> exo.volume = FULL_VOLUME
                null -> Unit
            }
        }

    private var focusHeld = false

    private fun syncAudioFocus(status: FfiPlayerStatus) {
        if (status == FfiPlayerStatus.PLAYING && !focusHeld) {
            focusHeld =
                audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) ==
                AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else if (status != FfiPlayerStatus.PLAYING && focusHeld) {
            abandonFocus()
        }
    }

    private fun abandonFocus() {
        audioManager.abandonAudioFocus(focusListener)
        focusHeld = false
        exo.volume = FULL_VOLUME
    }

    // The unplug trap: Media3 does not pause on BECOMING_NOISY by itself —
    // route it through the kernel like every other transport surface.
    // Registration lifecycle mirrors syncAudioFocus: held exactly while
    // playing, never on a non-playing path.
    private val noisyRouter =
        NoisyAudioRouter(
            register = {
                // AUDIO_BECOMING_NOISY is a protected system broadcast, so
                // the plain two-arg registerReceiver is legal on targetSdk
                // 36 — no RECEIVER_EXPORTED/NOT_EXPORTED flag needed.
                registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
            },
            unregister = { unregisterReceiver(noisyReceiver) },
            onPause = { bridge?.userPause() },
        )

    // The function breaks the router/receiver initializer cycle (a
    // property-initializer reference both ways is a typechecker
    // recursion; bodies of functions are deferred).
    private fun routeNoisy(action: String?) {
        noisyRouter.onReceive(action)
    }

    private val noisyReceiver =
        object : BroadcastReceiver() {
            override fun onReceive(
                context: Context?,
                intent: Intent?,
            ) {
                routeNoisy(intent?.action)
            }
        }

    private companion object {
        const val FULL_VOLUME = 1f
        const val DUCK_VOLUME = 0.2f
    }

    /** Persist a position change (fire-and-forget on the store's IO scope). */
    private fun persist(
        bookId: String,
        position: FfiPosition?,
    ) {
        if (position == null) return // resting/finished books keep their last save
        serviceScope.launch { positionStore.save(bookId, position) }
    }

    /** The onDestroy best-effort write — synchronous, bounded, last word. */
    private fun persistOnce() {
        val bookId = openBookId ?: return
        val position = bridge?.position() ?: return
        runCatching {
            kotlinx.coroutines.runBlocking { positionStore.save(bookId, position) }
        }
    }

    private fun stateBundle(): Bundle {
        val current = bridge
        val bookId = openBookId
        if (current == null || bookId == null) return SessionCommands.emptyStateBundle()
        return snapshotBundle(bookId, openAudioPresent, current.snapshot())
    }

    private fun snapshotBundle(
        bookId: String,
        audioPresent: Boolean,
        snap: dev.l1br3.taletrek.ffi.FfiStateSnapshot,
    ): Bundle =
        Bundle().apply {
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
            snap.failures.lastError?.let { putString(SessionCommands.STATE_LAST_ERROR, it) }
            putString(SessionCommands.STATE_BOOK_ID, bookId)
            putBoolean(SessionCommands.STATE_AUDIO_PRESENT, audioPresent)
        }
}

/**
 * The becoming-noisy half of interruption: unplugging headphones must
 * pause the book the way a focus loss does — through the kernel
 * ([PlaybackService]'s `bridge.userPause()`, never a behind-its-back
 * ExoPlayer pause). Pure and lambda-seamed so the JVM gate test covers
 * the registration boundary without android.jar; no auto-resume on
 * re-plug (the focus policy's stance, verbatim).
 */
internal class NoisyAudioRouter(
    private val register: () -> Unit,
    private val unregister: () -> Unit,
    private val onPause: () -> Unit,
) {
    private var held = false

    /** Idempotent playing-boundary gate — the focusHeld shape. */
    fun sync(status: FfiPlayerStatus) {
        if (status == FfiPlayerStatus.PLAYING && !held) {
            register()
            held = true
        } else if (status != FfiPlayerStatus.PLAYING && held) {
            unregister()
            held = false
        }
    }

    /** Maps only the noisy action; anything else (or null) is ignored. */
    fun onReceive(action: String?) {
        if (action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) onPause()
    }

    /** The destroy path — unregisters iff held (idempotent). */
    fun release() {
        if (held) {
            unregister()
            held = false
        }
    }
}
