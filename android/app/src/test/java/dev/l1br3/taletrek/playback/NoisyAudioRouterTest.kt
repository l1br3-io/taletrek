package dev.l1br3.taletrek.playback

import android.media.AudioManager
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The unplug gate — the becoming-noisy half of interruption handling:
 * the router is registered exactly while playing (churn-safe, the
 * focusHeld shape) and ACTION_AUDIO_BECOMING_NOISY maps to a pause
 * through the seams (the fake registrar — no android.jar at runtime;
 * the String constant is compile-time-inlined, same as
 * AudioFocusPolicyTest's ints).
 */
class NoisyAudioRouterTest {
    private class Recorder {
        var registered = 0
        var unregistered = 0
        var pauses = 0

        val router =
            NoisyAudioRouter(
                register = { registered += 1 },
                unregister = { unregistered += 1 },
                onPause = { pauses += 1 },
            )
    }

    @Test
    fun playingRegistersExactlyOnceAcrossRepeats() {
        val r = Recorder()
        repeat(5) { r.router.sync(FfiPlayerStatus.PLAYING) }
        assertEquals(1, r.registered)
        assertEquals(0, r.unregistered)
    }

    @Test
    fun nonPlayingStatusesNeverRegister() {
        listOf(FfiPlayerStatus.PAUSED, FfiPlayerStatus.IDLE).forEach { status ->
            val r = Recorder()
            r.router.sync(status)
            assertEquals(0, r.registered)
        }
    }

    @Test
    fun nonPlayingStatusesUnregisterAHeldReceiver() {
        listOf(FfiPlayerStatus.PAUSED, FfiPlayerStatus.IDLE).forEach { status ->
            val r = Recorder()
            r.router.sync(FfiPlayerStatus.PLAYING)
            r.router.sync(status)
            assertEquals(1, r.unregistered)
        }
    }

    @Test
    fun playPauseChurnEndsWithExactlyOneLiveRegistration() {
        val r = Recorder()
        listOf(
            FfiPlayerStatus.PLAYING,
            FfiPlayerStatus.PAUSED,
            FfiPlayerStatus.PLAYING,
            FfiPlayerStatus.PAUSED,
            FfiPlayerStatus.PLAYING,
        ).forEach { r.router.sync(it) }
        assertEquals(3, r.registered)
        assertEquals(2, r.unregistered)
        r.router.release()
        assertEquals(3, r.unregistered) // exactly one was live
    }

    @Test
    fun becomingNoisyInvokesPause() {
        val r = Recorder()
        r.router.onReceive(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        assertEquals(1, r.pauses)
    }

    @Test
    fun otherOrMissingActionsDoNothing() {
        val r = Recorder()
        r.router.onReceive("android.intent.action.MEDIA_BUTTON")
        r.router.onReceive(null)
        assertEquals(0, r.pauses)
    }

    @Test
    fun releaseUnregistersOnlyWhenHeld() {
        val held = Recorder()
        held.router.sync(FfiPlayerStatus.PLAYING)
        held.router.release()
        held.router.release() // idempotent
        assertEquals(1, held.unregistered)

        val idle = Recorder()
        idle.router.release()
        assertEquals(0, idle.unregistered)
    }
}
