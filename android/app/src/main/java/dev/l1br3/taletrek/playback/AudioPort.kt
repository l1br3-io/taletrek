package dev.l1br3.taletrek.playback

import java.io.File

/**
 * The audio engine as the bridge commands it — the ExoPlayer adapter in
 * production, a recorder in JVM tests. Mirrors the desktop's
 * `AudioTransport::load`/`stop` pair.
 */
interface AudioPort {
    /** Play `file`'s segment (identity: [mediaId]), [offsetMs] in. */
    fun load(
        file: File,
        mediaId: String,
        offsetMs: Long,
    )

    /** Silence output and drop the current segment. */
    fun stopOutput()
}
