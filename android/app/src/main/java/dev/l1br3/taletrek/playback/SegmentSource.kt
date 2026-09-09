package dev.l1br3.taletrek.playback

import dev.l1br3.taletrek.ffi.readSegment

/**
 * Where segment bytes come from — the kernel's streamed single-entry read
 * in production, canned bytes in JVM tests.
 */
interface SegmentSource {
    /** The segment's bytes, or null when the bundle carries none for `key`. */
    fun segment(key: String): ByteArray?
}

/** Production [SegmentSource] over the bundle file at [path]. */
class FileSegmentSource(
    private val path: String,
) : SegmentSource {
    override fun segment(key: String): ByteArray? = readSegment(path, key)
}
