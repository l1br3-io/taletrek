package dev.l1br3.taletrek.playback

import android.media.AudioManager
import dev.l1br3.taletrek.playback.AudioFocusPolicy.Response
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The audio-focus mapping — the T3 GOTCHA's promised hardening: focus
 * loss becomes a userPause (through the kernel, never behind its
 * back), ducks lower volume, gains restore it, garbage is ignored.
 */
class AudioFocusPolicyTest {
    @Test
    fun focusLossPauses() {
        assertEquals(Response.Pause, AudioFocusPolicy.onFocusChange(AudioManager.AUDIOFOCUS_LOSS))
        assertEquals(Response.Pause, AudioFocusPolicy.onFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
    }

    @Test
    fun duckLowersVolumeAndGainRestoresIt() {
        assertEquals(Response.Duck, AudioFocusPolicy.onFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
        assertEquals(Response.RestoreVolume, AudioFocusPolicy.onFocusChange(AudioManager.AUDIOFOCUS_GAIN))
    }

    @Test
    fun unknownChangesAreIgnored() {
        assertEquals(null, AudioFocusPolicy.onFocusChange(-999))
    }
}
