package dev.l1br3.taletrek.data

import android.content.Context
import android.net.Uri
import dev.l1br3.taletrek.ffi.exportMergedAudio
import dev.l1br3.taletrek.ffi.openBook
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/** One library row — manifest display data, nothing else. */
data class BookShelf(
    val bookId: String,
    val title: String,
    val author: String?,
    val chapterCount: Int,
    val audioPresent: Boolean,
    val path: String,
)

/** The scanned library: good books plus a count of unreadable ones. */
data class LibraryState(
    val books: List<BookShelf> = emptyList(),
    val skipped: Int = 0,
)

/** What an import attempt did — errors surface in the UI, never crash it. */
sealed interface ImportOutcome {
    data class Imported(
        val book: BookShelf,
    ) : ImportOutcome

    data class Rejected(
        val reason: String,
    ) : ImportOutcome
}

/**
 * The library's repo seam — the JVM tests fake this whole surface
 * (`BooksRepository` needs the kernel `.so`; it does not load on the JVM).
 */
interface BooksRepo {
    /** The scanned library; refreshes after import/delete/refresh. */
    val state: Flow<LibraryState>

    /** Rescan `books/` (also the initial load when the UI starts). */
    suspend fun refresh()

    /**
     * Copy-on-import a picked/opened document into `filesDir/books/`.
     * The URI crosses as a string so the seam stays JVM-testable
     * (`android.net.Uri` is not constructible in unit tests).
     */
    suspend fun importFrom(uri: String): ImportOutcome

    /** Delete a book's file and its orphaned position (best-effort). */
    suspend fun delete(book: BookShelf)

    /**
     * Merge the book's audio into one gapless `.opus` under
     * `cacheDir/exports/` and return it — generated on demand, I/O-bound;
     * the caller shares/copies the file and the OS reclaims the cache.
     * Throws on a text-only book or a failed merge.
     */
    suspend fun exportAudio(book: BookShelf): File
}

/**
 * The library: a directory scan of the bundle files in `filesDir/books`
 * read through the kernel (`openBook` — manifest + text; audio entries
 * are never touched). No database: the list *is* the manifests. A bad
 * file is a skipped count, never a dead library.
 */
class BooksRepository(
    private val context: Context,
    private val positions: PositionStore,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : BooksRepo {
    private val booksDir = File(context.filesDir, "books")

    private val _state = MutableStateFlow(LibraryState())
    override val state = _state.asStateFlow()

    override suspend fun refresh() {
        withContext(ioDispatcher) {
            val files =
                booksDir
                    .listFiles { f -> f.isFile && f.name.endsWith(BUNDLE_EXT) }
                    .orEmpty()
                    .sortedBy { it.name }
            val books =
                files
                    .mapNotNull { file ->
                        runCatching { openBook(file.absolutePath) }.getOrNull()?.let { book ->
                            BookShelf(
                                bookId = book.bookId,
                                title = book.title,
                                author = book.author,
                                chapterCount = book.chapters.size,
                                audioPresent = book.audioPresent,
                                path = file.absolutePath,
                            )
                        }
                    }.sortedBy { it.title.lowercase() }
            _state.value = LibraryState(books = books, skipped = files.size - books.size)
        }
    }

    override suspend fun importFrom(uri: String): ImportOutcome =
        withContext(ioDispatcher) {
            // GOTCHA: SAF grants are transient — the app owns copies, never
            // the picked URI. Everything below is staged through a temp file
            // so a rejected import leaves no residue in books/.
            booksDir.mkdirs()
            val staged =
                File.createTempFile("import", ".tmp", booksDir).apply {
                    deleteOnExit() // belt-and-braces; the paths below own it
                }
            try {
                val input =
                    context.contentResolver.openInputStream(Uri.parse(uri))
                        ?: throw IOException("unreadable document")
                input.use { source -> staged.outputStream().use { source.copyTo(it) } }
                // Validation IS the kernel read: openBook on the staged copy
                // (manifest + text) before anything lands under its book id.
                val book = openBook(staged.absolutePath)
                val dest = File(booksDir, "${book.bookId}$BUNDLE_EXT")
                // Same-id re-import = overwrite by design (one entry, never two).
                if (dest.exists() && !dest.delete()) throw IOException("cannot replace ${dest.name}")
                if (!staged.renameTo(dest)) throw IOException("cannot store ${dest.name}")
                refresh()
                ImportOutcome.Imported(
                    BookShelf(
                        bookId = book.bookId,
                        title = book.title,
                        author = book.author,
                        chapterCount = book.chapters.size,
                        audioPresent = book.audioPresent,
                        path = dest.absolutePath,
                    ),
                )
            } catch (e: Exception) {
                staged.delete()
                ImportOutcome.Rejected(e.message ?: e.javaClass.simpleName)
            }
        }

    override suspend fun delete(book: BookShelf) {
        withContext(ioDispatcher) {
            File(book.path).delete()
            // Best-effort: a position that won't clear never blocks the delete.
            runCatching { positions.clear(book.bookId) }
            refresh()
        }
    }

    override suspend fun exportAudio(book: BookShelf): File =
        withContext(ioDispatcher) {
            // GOTCHA: exports live only in cacheDir/exports — never
            // filesDir/books/, which stays exactly one bundle per book.
            val dir = File(context.cacheDir, "exports").apply { mkdirs() }
            val dest = File(dir, "${book.bookId}$OPUS_EXT")
            exportMergedAudio(book.path, dest.absolutePath)
            if (!dest.isFile || dest.length() == 0L) throw IOException("merge produced no audio")
            dest
        }

    private companion object {
        const val BUNDLE_EXT = ".taletrek"
        const val OPUS_EXT = ".opus"
    }
}
