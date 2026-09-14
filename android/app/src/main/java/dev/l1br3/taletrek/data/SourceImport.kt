package dev.l1br3.taletrek.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Which intake lane a picked document takes. */
enum class PickedLane {
    /** A finished `.taletrek` bundle — copy-on-import into the library. */
    BUNDLE,

    /** A source document — the on-device convert pipeline. */
    SOURCE,
}

/**
 * Source-document import plumbing: the SAF/intent mime map and the
 * single-pick lane router, plus the copy-to-cache policy (SAF streams
 * can't be reopened and parse wants bytes anyway — the copy is the job's
 * input and is deleted when the job ends).
 */
object SourceImport {
    /**
     * Route one picked document: a display name ending in `.taletrek` is
     * a bundle; everything else — known source formats, mislabeled mimes,
     * unknown names — is a source document, where the kernel's
     * `detect_format` content-sniffs and fails with a clear error if it
     * can't. Extension beats mime here: SAF mimes lie (`octet-stream`
     * covers both lanes), and the source lane is the safe default
     * because sniffing arbitrates.
     */
    fun laneOf(displayName: String?): PickedLane =
        if (displayName != null && displayName.endsWith(".taletrek", ignoreCase = true)) {
            PickedLane.BUNDLE
        } else {
            PickedLane.SOURCE
        }

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
