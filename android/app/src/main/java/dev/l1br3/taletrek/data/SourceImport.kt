package dev.l1br3.taletrek.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Source-document import plumbing: the six kernel-parseable types, the
 * SAF/intent mime map, and the copy-to-cache policy (SAF streams can't be
 * reopened and parse wants bytes anyway — the copy is the job's input and
 * is deleted when the job ends).
 */
object SourceImport {
    /** The picker's mime array for source documents (all six types). */
    val PICKER_MIME_TYPES =
        arrayOf(
            "application/epub+zip",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/html",
            "text/markdown",
            "text/plain",
        )

    /**
     * Does `mime` (from an intent or content resolver) name a source
     * document we convert? `null`/unknown mimes route here too when the
     * display name carries a known extension — mislabeled and
     * extension-less payloads are the kernel's `detect_format`'s job
     * (content sniffing first, extension fallback). `octet-stream` is
     * deliberately ABSENT: that's the `.taletrek` bundle lane (the
     * manifest filter's mime — see the existing bundle-import GOTCHA).
     */
    fun isSourceMime(mime: String?): Boolean =
        mime == null ||
            (
                mime.startsWith("text/") ||
                    mime == "application/epub+zip" ||
                    mime == "application/pdf" ||
                    mime ==
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            )

    /** A display-name/hint for the kernel (title fallback + format hint). */
    suspend fun displayNameOf(
        context: Context,
        uri: Uri,
    ): String? =
        withContext(Dispatchers.IO) {
            runCatching {
                context.contentResolver
                    .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                    ?.use { cursor ->
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0 && cursor.moveToFirst()) cursor.getString(idx) else null
                    }
            }.getOrNull()
        }

    /**
     * Copy the content URI into the app's own cache (unique per import) —
     * returns the copied file. The file's lifecycle belongs to the caller
     * (the import view model deletes it when the job ends).
     */
    suspend fun copyToCache(
        context: Context,
        uri: Uri,
    ): File =
        withContext(Dispatchers.IO) {
            val dest = File(context.cacheDir, "import-source-${System.nanoTime()}")
            context.contentResolver.openInputStream(uri)?.use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            } ?: error("no stream for $uri")
            dest
        }

    /** Best-effort cache-file cleanup — never throws. */
    fun deleteQuietly(file: File?) {
        file?.let { runCatching { it.delete() } }
    }
}
