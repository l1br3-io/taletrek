package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.ffi.FfiAnchor
import java.io.File
import java.util.Properties

/**
 * The relaunch-resume record: the one in-flight import (the service's
 * job slot is single) persisted next to the library so process death
 * mid-job is recoverable. Saved at submit with a snapshot of the bundle
 * paths already in `books/`; spent (cleared) when the job reaches any
 * terminal state. The source copy's cache lifetime is the real clock —
 * an evicted source makes the record unresumable and the resume flow
 * clears it.
 */
class PendingJobStore(
    filesDir: File,
) {
    /** One persisted job: the request to replay plus the shelf as it was. */
    data class PendingJob(
        val request: SynthJobRequest,
        val preExistingBookPaths: List<String>,
    )

    private val file = File(filesDir, FILE_NAME)

    fun save(job: PendingJob) {
        val props = Properties()
        val request = job.request
        props.setProperty(KEY_SOURCE, request.sourcePath)
        request.hint?.let { props.setProperty(KEY_HINT, it) }
        request.voiceId?.let { props.setProperty(KEY_VOICE, it) }
        props.setProperty(KEY_VOICE_CACHE, request.voiceCacheDir)
        props.setProperty(KEY_ESPEAK, request.espeakDir)
        props.setProperty(KEY_BOOKS, request.booksDir)
        props.setProperty(KEY_STORE, request.storeDir)
        props.setProperty(KEY_JOBS, request.jobs.toString())
        props.setProperty(KEY_GENERATOR, request.generatorApp)
        request.initialAnchor?.let {
            props.setProperty(KEY_ANCHOR_CH, it.chapter.toLong().toString())
            props.setProperty(KEY_ANCHOR_P, it.paragraph.toLong().toString())
        }
        props.setProperty(KEY_PREEXISTING, job.preExistingBookPaths.joinToString(SEP))
        file.parentFile?.mkdirs()
        file.outputStream().use { props.store(it, null) }
    }

    /** The persisted job, or null when none is pending (or the record is unreadable). */
    fun load(): PendingJob? {
        if (!file.isFile) return null
        val props =
            runCatching {
                file.inputStream().use { Properties().apply { load(it) } }
            }.getOrNull() ?: return null
        val source = props.getProperty(KEY_SOURCE) ?: return null
        val anchorCh = props.getProperty(KEY_ANCHOR_CH)?.toLongOrNull()
        val anchorP = props.getProperty(KEY_ANCHOR_P)?.toLongOrNull()
        return PendingJob(
            request =
                SynthJobRequest(
                    sourcePath = source,
                    hint = props.getProperty(KEY_HINT),
                    voiceId = props.getProperty(KEY_VOICE),
                    voiceCacheDir = props.getProperty(KEY_VOICE_CACHE) ?: return null,
                    espeakDir = props.getProperty(KEY_ESPEAK) ?: return null,
                    booksDir = props.getProperty(KEY_BOOKS) ?: return null,
                    storeDir = props.getProperty(KEY_STORE) ?: return null,
                    jobs = props.getProperty(KEY_JOBS)?.toIntOrNull() ?: 2,
                    generatorApp = props.getProperty(KEY_GENERATOR) ?: "taletrek-android",
                    initialAnchor =
                        if (anchorCh != null && anchorP != null && anchorCh >= 0 && anchorP >= 0) {
                            FfiAnchor(anchorCh.toUInt(), anchorP.toUInt())
                        } else {
                            null
                        },
                ),
            preExistingBookPaths =
                props.getProperty(KEY_PREEXISTING)?.split(SEP)?.filter { it.isNotEmpty() }
                    ?: emptyList(),
        )
    }

    /** Spend the record — the job ended (or became unresumable). */
    fun clear() {
        runCatching { file.delete() }
    }

    private companion object {
        const val FILE_NAME = "pending_synthjob.properties"
        const val SEP = "\n"
        const val KEY_SOURCE = "source"
        const val KEY_HINT = "hint"
        const val KEY_VOICE = "voice"
        const val KEY_VOICE_CACHE = "voiceCache"
        const val KEY_ESPEAK = "espeak"
        const val KEY_BOOKS = "books"
        const val KEY_STORE = "store"
        const val KEY_JOBS = "jobs"
        const val KEY_GENERATOR = "generator"
        const val KEY_ANCHOR_CH = "anchorChapter"
        const val KEY_ANCHOR_P = "anchorParagraph"
        const val KEY_PREEXISTING = "preExisting"
    }
}
