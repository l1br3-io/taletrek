package dev.l1br3.taletrek

import android.net.Uri
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.data.BooksRepository
import dev.l1br3.taletrek.data.ImportOutcome
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.ffi.FfiPosition
import dev.l1br3.taletrek.ffi.openBook
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The library's kernel-touching half, on device: import (the SAF
 * contract faked with a local file URI — the resolver path is the
 * same), scan resilience, and delete. The manifest-driven list is the
 * whole library — no database anywhere in here.
 */
@RunWith(AndroidJUnit4::class)
class ImportScanTest {
    @Test
    fun copyOnImportRoundTripsAndReimportOverwrites() =
        runBlocking {
            val repo = freshRepo("roundtrip")
            val source = fixtureInCache("book-playable.taletrek")

            val first = repo.importFrom(Uri.fromFile(source).toString())

            assertTrue(first is ImportOutcome.Imported)
            first as ImportOutcome.Imported
            assertEquals("bk_sample", first.book.bookId)
            assertEquals("Sample Book", first.book.title)
            assertEquals(2, first.book.chapterCount)
            assertTrue(first.book.audioPresent)

            val state = repo.state.value
            assertEquals(1, state.books.size)
            assertEquals("bk_sample", state.books.single().bookId)

            // Same document again = the same book id = one entry, replaced.
            val again = repo.importFrom(Uri.fromFile(source).toString())
            assertTrue(again is ImportOutcome.Imported)
            assertEquals(1, repo.state.value.books.size)
        }

    @Test
    fun aNonBundleIsRejectedAndLeavesNoResidue() =
        runBlocking {
            val repo = freshRepo("reject")
            val junk = File(context().cacheDir, "junk-${System.nanoTime()}.taletrek")
            junk.writeBytes(byteArrayOf(0x50, 0x4b, 0x03, 0x04) + "not really a bundle".repeat(64).toByteArray())

            val outcome = repo.importFrom(Uri.fromFile(junk).toString())

            assertTrue(outcome is ImportOutcome.Rejected)
            val booksDir = File(context().filesDir, "books")
            assertEquals(
                emptyList<File>(),
                booksDir.listFiles().orEmpty().toList(),
            )
        }

    @Test
    fun scanSkipsBadBooksButListsGoodOnes() =
        runBlocking {
            val repo = freshRepo("skip")
            val booksDir = File(context().filesDir, "books").apply { mkdirs() }
            fixtureInCache("book-playable.taletrek").copyTo(File(booksDir, "keeper.taletrek"), overwrite = true)
            File(booksDir, "corrupt.taletrek").writeText("definitely not a zip")

            repo.refresh()

            val state = repo.state.value
            assertEquals(1, state.books.size)
            assertEquals("bk_sample", state.books.single().bookId)
            assertEquals(1, state.skipped)
        }

    @Test
    fun deleteRemovesTheFileAndClearsThePosition() =
        runBlocking {
            val store = testStore("delete")
            val repo = BooksRepository(context(), store)
            cleanBooksDir()
            val source = fixtureInCache("book-playable.taletrek")
            val imported = repo.importFrom(Uri.fromFile(source).toString()) as ImportOutcome.Imported

            store.save("bk_sample", FfiPosition(1u, 0u, 0.5))

            repo.delete(imported.book)

            assertEquals(emptyList<File>(), File(context().filesDir, "books").listFiles().orEmpty().toList())
            assertEquals(null, store.load("bk_sample"))
            assertEquals(0, repo.state.value.books.size)
        }

    /** The open_book cost input for the manifest-only-API open question. */
    @Test
    fun openBookCostOnTheFixtureIsLogged() =
        runBlocking {
            val path = fixtureInCache("book-playable.taletrek").absolutePath
            withContext(Dispatchers.IO) {
                openBook(path) // warm the mmap/page cache
                val start = System.nanoTime()
                openBook(path)
                val elapsedMs = (System.nanoTime() - start) / 1_000_000.0
                android.util.Log.i("ImportScanTest", "open_book(book-playable) = ${elapsedMs}ms")
                assertTrue(elapsedMs < 5_000)
            }
        }

    private fun context() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun cleanBooksDir() {
        File(context().filesDir, "books").deleteRecursively()
    }

    private fun freshRepo(name: String): BooksRepository {
        cleanBooksDir()
        return BooksRepository(context(), testStore(name))
    }

    private fun fixtureInCache(asset: String): File =
        File(context().cacheDir, "scan-$asset").apply {
            InstrumentationRegistry.getInstrumentation().context.assets.open(asset).use { input ->
                outputStream().use { output -> input.copyTo(output) }
            }
        }

    private fun testStore(name: String): PositionStore {
        val scope =
            kotlinx.coroutines.CoroutineScope(
                kotlinx.coroutines.SupervisorJob() + Dispatchers.IO,
            )
        val file = context().preferencesDataStoreFile("test_positions_scan_${name}_${System.nanoTime()}")
        return PositionStore(
            androidx.datastore.preferences.core.PreferenceDataStoreFactory
                .create(scope = scope) { file },
        )
    }
}
