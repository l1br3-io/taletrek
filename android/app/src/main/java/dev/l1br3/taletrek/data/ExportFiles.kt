package dev.l1br3.taletrek.data

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/** What a book exports as — MIME type and file extension travel together. */
enum class ExportKind(
    val mime: String,
    val ext: String,
) {
    /** The `.taletrek` interchange bundle (a zip — same MIME the web imports). */
    BUNDLE("application/zip", "taletrek"),

    /** The merged whole-book audio stream. */
    AUDIO("audio/ogg", "opus"),
}

/**
 * Export plumbing that is pure enough to reason about: the FileProvider
 * authority, suggested download names, and the share-intent shape. The
 * JVM tests own the name/MIME half; the Uri/Intent half needs a device
 * and is covered by the instrumented export test.
 */
object ExportFiles {
    /** Must match AndroidManifest.xml's provider + res/xml/file_provider_paths.xml. */
    const val AUTHORITY = "dev.l1br3.taletrek.export"

    /**
     * The human-facing download name: `<title>.<ext>`. Titles are user
     * data — separators, punctuation that SAF/share targets mishandle,
     * and trailing dots are sanitized away; an empty stem falls back to
     * the book id. The result is always one safe name component.
     */
    fun suggestedFileName(
        bookId: String,
        title: String,
        kind: ExportKind,
    ): String {
        val stem =
            title
                .replace(ILLEGAL, " ")
                .replace(WHITESPACE, " ")
                .trim()
                .trimEnd('.')
                .ifBlank { bookId }
        return "$stem.${kind.ext}"
    }

    /** A shareable content:// URI for `file` (must live under a granted path). */
    fun providerUri(
        context: Context,
        file: File,
    ): Any = FileProvider.getUriForFile(context, AUTHORITY, file)

    /**
     * ACTION_SEND chooser for one exported artifact. GOTCHA: the grant
     * flag rides the ACTION_SEND intent (the chooser wraps but preserves
     * it); without it the receiving app gets a security exception.
     */
    fun shareIntent(
        context: Context,
        file: File,
        mime: String,
        title: String,
    ): Intent =
        Intent.createChooser(
            Intent(Intent.ACTION_SEND)
                .setType(mime)
                .putExtra(Intent.EXTRA_STREAM, FileProvider.getUriForFile(context, AUTHORITY, file))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            title,
        )

    private val ILLEGAL = Regex("[\\\\/:*?\"<>|\u0000]")
    private val WHITESPACE = Regex("\\s+")
}
