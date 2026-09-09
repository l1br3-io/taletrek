package dev.l1br3.taletrek.data

import android.content.Context
import dev.l1br3.taletrek.ffi.FfiBook
import dev.l1br3.taletrek.ffi.openBook
import dev.l1br3.taletrek.playback.TrekKernelPlayer
import java.io.File

/**
 * The open flow — the read-side counterpart of the desktop's
 * `session::open`: bundle path in, a session (book + kernel + path) out.
 * Restore semantics live in the kernel glue from task 001: a saved
 * position that validates seeds the machine **paused** at the saved
 * paragraph (never an auto-play), an out-of-range one seeds fresh idle.
 */
class BookSession(
    val book: FfiBook,
    val kernel: TrekKernelPlayer,
    val path: String,
) {
    companion object {
        /**
         * Open the bundle at [path], restoring any saved position for its
         * book id. Filesystem/parse failures propagate as exceptions (the
         * caller surfaces them); position loading never fails the open.
         */
        suspend fun open(
            context: Context,
            path: String,
            store: PositionStore,
        ): BookSession {
            val book = openBook(path) // kernel read; caller's dispatcher is IO
            val restored = store.load(book.bookId)
            val kernel =
                if (restored != null) {
                    TrekKernelPlayer(book, restored)
                } else {
                    TrekKernelPlayer(book)
                }
            return BookSession(book, kernel, path)
        }
    }

    /** The session's bundle file still exists (005's library scan guard). */
    fun bundleExists(): Boolean = File(path).isFile
}
