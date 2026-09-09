package dev.l1br3.taletrek.playback

import android.media.AudioManager

/**
 * The audio-focus decision table — total, pure, tested. Focus loss
 * becomes a **userPause** (through the kernel, never a behind-its-back
 * ExoPlayer pause — the desync trap the T3 GOTCHA flagged); ducks
 * lower volume only; a gain restores volume but never auto-resumes
 * (resume is the user's call).
 */
object AudioFocusPolicy {
    sealed interface Response {
        data object Pause : Response

        data object Duck : Response

        data object RestoreVolume : Response
    }

    fun onFocusChange(change: Int): Response? =
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> Response.Pause
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> Response.Duck
            AudioManager.AUDIOFOCUS_GAIN -> Response.RestoreVolume
            else -> null
        }
}
