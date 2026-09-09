package dev.l1br3.taletrek.playback

import dev.l1br3.taletrek.ffi.FfiBook
import dev.l1br3.taletrek.ffi.FfiPlayerAction
import dev.l1br3.taletrek.ffi.FfiPlayerEvent
import dev.l1br3.taletrek.ffi.FfiPosition
import dev.l1br3.taletrek.ffi.FfiStateSnapshot
import dev.l1br3.taletrek.ffi.TrekPlayer

/**
 * The kernel player as the bridge sees it — the generated [TrekPlayer] in
 * production (JNI), a scripted fake in JVM tests. Mirrors the desktop's
 * `AudioTransport` seam: the bridge talks to the kernel through exactly
 * these calls, and adds no sequencing of its own.
 */
interface KernelPlayer {
    fun tick(event: FfiPlayerEvent): FfiPlayerAction

    fun snapshot(): FfiStateSnapshot

    fun position(): FfiPosition?

    fun close()
}

/** Production [KernelPlayer] over the generated UniFFI [TrekPlayer]. */
class TrekKernelPlayer(
    private val player: TrekPlayer,
) : KernelPlayer {
    constructor(book: FfiBook) : this(TrekPlayer(book))

    override fun tick(event: FfiPlayerEvent): FfiPlayerAction = player.tick(event)

    override fun snapshot(): FfiStateSnapshot = player.stateSnapshot()

    override fun position(): FfiPosition? = player.position()

    override fun close() = player.close()
}
