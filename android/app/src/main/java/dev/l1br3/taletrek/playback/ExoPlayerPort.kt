package dev.l1br3.taletrek.playback

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import java.io.File

/**
 * The ExoPlayer adapter: commands out to the platform player, platform
 * callbacks in to the bridge. Decode is the platform's (OGG extractor +
 * Opus decoder — no audio code crosses into the kernel's `.so`). The
 * media id carries the segment key so drains are always tagged.
 */
class ExoPlayerPort(
    private val player: Player,
) : AudioPort,
    Player.Listener {
    private lateinit var bridge: PlayerBridge

    private val appliedLoads = mutableListOf<String>()

    var stops = 0
        private set

    /** Wire the bridge this port reports into (constructed after the port). */
    fun attach(bridge: PlayerBridge) {
        this.bridge = bridge
        player.addListener(this)
    }

    override fun load(
        file: File,
        mediaId: String,
        offsetMs: Long,
    ) {
        appliedLoads.add(mediaId)
        val item =
            MediaItem
                .Builder()
                .setUri(Uri.fromFile(file))
                .setMediaId(mediaId)
                .build()
        player.setMediaItem(item, offsetMs)
        player.prepare()
        player.play()
    }

    override fun stopOutput() {
        stops++
        player.pause()
        player.clearMediaItems()
    }

    // --- platform callbacks in -------------------------------------------

    override fun onPlaybackStateChanged(playbackState: Int) {
        when (playbackState) {
            Player.STATE_READY -> bridge.onReady()
            Player.STATE_ENDED -> bridge.onEnded()
            else -> Unit
        }
    }

    override fun onPlayerError(error: PlaybackException) {
        bridge.onError(error)
    }

    /** The loads applied so far, in order (the walk test's probe). */
    fun appliedLoads(): List<String> = synchronized(appliedLoads) { appliedLoads.toList() }
}
