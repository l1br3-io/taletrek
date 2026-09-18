package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.ffi.FfiAnchor
import dev.l1br3.taletrek.ffi.FfiPosition
import java.io.File

/**
 * Relaunch resume: process death mid-fill leaves a pending record, the
 * source copy, a text-only bundle, and a warm segment store — resubmit
 * the same job (kernel skip-existing does the rest), aimed at where the
 * reader left off. The one ambiguity (several new text-only books — a
 * desktop bundle imported mid-job) resolves to book start: the reader
 * re-anchors live via `set_anchor` once opened.
 */
class PendingImportResume(
    private val store: PendingJobStore,
    private val loadPosition: suspend (bookId: String) -> FfiPosition?,
    private val isConverting: () -> Boolean,
    private val startJob: (SynthJobRequest) -> Unit,
) {
    /** Attempt one resume — submits only when a pending job is resumable. */
    suspend fun resumeWith(books: List<BookShelf>) {
        val pending = store.load() ?: return
        if (!File(pending.request.sourcePath).isFile) {
            store.clear()
            return
        }
        if (isConverting()) return
        val anchor =
            books
                .filter { !it.audioPresent && it.path !in pending.preExistingBookPaths }
                .singleOrNull()
                ?.let { loadPosition(it.bookId) }
                ?.let { FfiAnchor(chapter = it.chapter, paragraph = it.index) }
        startJob(pending.request.copy(initialAnchor = anchor))
    }
}
