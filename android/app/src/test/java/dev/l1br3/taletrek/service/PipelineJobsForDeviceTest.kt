package dev.l1br3.taletrek.service

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * [pipelineJobsForDevice] — the LMK guard for on-device full synth. Each
 * sherpa runner ≈ 300–420 MB steady-state (model + never-shrinking ORT
 * arena); the floor decides when a second runner stops being safe.
 */
class PipelineJobsForDeviceTest {
    @Test
    fun bigRamDeviceKeepsBothRunners() {
        assertEquals(2, pipelineJobsForDevice(totalMemBytes = 8L shl 30, isLowRamDevice = false))
    }

    @Test
    fun smallRamDeviceSerializes() {
        assertEquals(1, pipelineJobsForDevice(totalMemBytes = 2L shl 30, isLowRamDevice = false))
    }

    @Test
    fun atTheFloorBothRunnersFit() {
        assertEquals(
            2,
            pipelineJobsForDevice(totalMemBytes = LOW_RAM_DEVICE_FLOOR_BYTES, isLowRamDevice = false),
        )
    }

    @Test
    fun lowRamFlagWinsEvenWithPlentyOfRam() {
        assertEquals(1, pipelineJobsForDevice(totalMemBytes = 8L shl 30, isLowRamDevice = true))
    }
}
