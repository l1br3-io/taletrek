package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.data.BooksRepo
import dev.l1br3.taletrek.data.ImportOutcome
import dev.l1br3.taletrek.data.LibraryState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The library's list-state logic over a faked repo seam — the JVM half
 * of the spec's testing split (the `.so` does not load here; scan/import
 * over the real kernel is instrumented, in ImportScanTest).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LibraryViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val repo = FakeRepo()
    private lateinit var vm: LibraryViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        vm = LibraryViewModel(repo)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun aFreshViewModelStartsLoading() {
        // Observed strictly between construction and the first scan —
        // no dispatcher advance (the collector would land immediately).
        val fresh = LibraryViewModel(repo)
        assertTrue(fresh.ui.value.loading)
    }

    @Test
    fun theFirstScanLandsAndClearsLoading() =
        runTest(dispatcher) {
            repo.emit(LibraryState(books = listOf(shelf("bk_a"))))
            advanceUntilIdle()
            val ui = vm.ui.value
            assertFalse(ui.loading)
            assertEquals(listOf(shelf("bk_a")), ui.books)
            assertEquals(0, ui.skipped)
        }

    @Test
    fun scanSkipsSurfaceAsACountNeverADeadLibrary() =
        runTest(dispatcher) {
            repo.emit(LibraryState(books = listOf(shelf("bk_a")), skipped = 2))
            advanceUntilIdle()
            assertEquals(2, vm.ui.value.skipped)
            assertEquals(1, vm.ui.value.books.size)
        }

    @Test
    fun aRejectedImportSurfacesItsErrorUntilDismissed() =
        runTest(dispatcher) {
            repo.nextImport = ImportOutcome.Rejected("not a bundle")
            vm.onImportPicked("content://fake/pick")
            advanceUntilIdle()
            assertEquals("not a bundle", vm.ui.value.importError)

            vm.dismissImportError()
            assertNull(vm.ui.value.importError)
        }

    @Test
    fun aSuccessfulImportClearsAStaleError() =
        runTest(dispatcher) {
            repo.nextImport = ImportOutcome.Rejected("not a bundle")
            vm.onImportPicked("content://fake/pick")
            advanceUntilIdle()
            assertEquals("not a bundle", vm.ui.value.importError)

            repo.nextImport = ImportOutcome.Imported(shelf("bk_a"))
            vm.onImportPicked("content://fake/pick")
            advanceUntilIdle()
            assertNull(vm.ui.value.importError)
        }

    @Test
    fun deleteNeedsConfirmationAndOnlyThenDeletes() =
        runTest(dispatcher) {
            val book = shelf("bk_a")
            vm.requestDelete(book)
            assertEquals(book, vm.ui.value.pendingDelete)
            assertTrue(repo.deleted.isEmpty())

            vm.cancelDelete()
            assertNull(vm.ui.value.pendingDelete)
            assertTrue(repo.deleted.isEmpty())

            vm.requestDelete(book)
            vm.confirmDelete()
            advanceUntilIdle()
            assertNull(vm.ui.value.pendingDelete)
            assertEquals(listOf(book), repo.deleted)
        }

    private fun shelf(id: String) =
        BookShelf(
            bookId = id,
            title = "Title $id",
            chapterCount = 2,
            audioPresent = true,
            path = "/books/$id.taletrek",
        )

    private class FakeRepo : BooksRepo {
        private val _state = MutableStateFlow(LibraryState())
        override val state = _state.asStateFlow()

        var nextImport: ImportOutcome =
            ImportOutcome.Imported(BookShelf("bk_x", "X", 1, false, "/books/bk_x.taletrek"))
        val deleted = mutableListOf<BookShelf>()

        fun emit(state: LibraryState) {
            _state.value = state
        }

        override suspend fun refresh() {}

        override suspend fun importFrom(uri: String): ImportOutcome = nextImport

        override suspend fun delete(book: BookShelf) {
            deleted += book
        }
    }
}
