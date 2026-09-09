package dev.l1br3.taletrek.playback

import java.io.File

/**
 * The temp-file discipline (v1 segment delivery): one paragraph's segment
 * extracted to the cache dir, played by path, deleted on advance or stop.
 * At most one file is ever resident — an unbounded cache this is not.
 */
class SegmentCache(
    private val dir: File,
) {
    /** Write `bytes` as the resident segment file for `key` (atomic tmp+rename). */
    fun write(
        key: String,
        bytes: ByteArray,
    ): File {
        dir.mkdirs()
        // A previous same-key file may exist; the rename replaces it.
        val file = File(dir, "$key.ogg")
        val tmp = File(dir, "$key.ogg.tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(file)) {
            tmp.delete()
            file.writeBytes(bytes)
        }
        // ≤1 resident: everything that is not the new file goes.
        dir.listFiles()?.forEach {
            if (it != file) it.delete()
        }
        return file
    }

    /** Delete the resident file, if any. */
    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
    }

    /** How many segment files are resident (the discipline's test probe). */
    fun residentCount(): Int = dir.listFiles()?.size ?: 0
}
