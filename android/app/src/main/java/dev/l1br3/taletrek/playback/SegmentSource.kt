package dev.l1br3.taletrek.playback

import dev.l1br3.taletrek.ffi.FfiSegmentStatus
import dev.l1br3.taletrek.ffi.readSegment
import dev.l1br3.taletrek.ffi.readSegmentProgressive

/**
 * One segment read attempt — the bridge turns these into playback,
 * kernel skip reports, or the progressive wait.
 */
sealed interface SegmentFetch {
    /** The segment's bytes. */
    data class Bytes(
        val data: ByteArray,
    ) : SegmentFetch

    /** Not in the bundle — the kernel's skip path (corrupt archive or
     *  foreign key; never wait-worthy). */
    data object Absent : SegmentFetch

    /** Expected but not synthesized yet — the book is filling; the
     *  bridge waits (buffering) while a job may still land it. */
    data object NotYet : SegmentFetch
}

/**
 * Where segment bytes come from — the kernel's streamed single-entry
 * read in production, canned outcomes in JVM tests.
 */
interface SegmentSource {
    /** One read attempt for `key`. */
    fun segment(key: String): SegmentFetch
}

/** Production [SegmentSource] over the sealed bundle file at [path]. */
class FileSegmentSource(
    private val path: String,
) : SegmentSource {
    override fun segment(key: String): SegmentFetch {
        val bytes = readSegment(path, key) ?: return SegmentFetch.Absent
        return SegmentFetch.Bytes(bytes)
    }
}

/**
 * The filling book's [SegmentSource]: `read_segment_progressive` maps
 * `Ready` to bytes, `Missing` to the skip path, and `NotReady` to the
 * retryable wait — the bridge owns the waiting (buffering UX + the
 * dead-job stall), this stays a pure one-shot read.
 */
class ProgressiveSegmentSource(
    private val path: String,
    private val read: (path: String, key: String) -> FfiSegmentStatus = ::readSegmentProgressive,
) : SegmentSource {
    override fun segment(key: String): SegmentFetch =
        when (val status = read(path, key)) {
            is FfiSegmentStatus.Ready -> SegmentFetch.Bytes(status.`bytes`)
            FfiSegmentStatus.Missing -> SegmentFetch.Absent
            FfiSegmentStatus.NotReady -> SegmentFetch.NotYet
        }
}
