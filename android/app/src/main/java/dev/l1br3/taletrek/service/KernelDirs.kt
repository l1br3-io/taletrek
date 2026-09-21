package dev.l1br3.taletrek.service

import android.content.Context
import java.io.File

/**
 * Host dirs the kernel resolves nothing about — one definition each,
 * every caller shared (the import requests and the playback service's
 * process-start registration must never drift apart).
 */
object KernelDirs {
    /** The deterministic segment-store root: where progressive jobs
     *  synth into and `read_segment_progressive` serves landed segments
     *  from. Registered at process start so the FFI player's text-only
     *  gate passes before any job has ever run. */
    fun segmentStoreDir(context: Context): String = File(context.cacheDir, "taletrek/segments").path
}
