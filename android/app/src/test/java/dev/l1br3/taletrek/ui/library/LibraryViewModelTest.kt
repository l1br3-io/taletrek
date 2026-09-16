package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.data.BooksRepo
import dev.l1br3.taletrek.data.ImportOutcome
import dev.l1br3.taletrek.data.LibraryState
import kotlinx.coroutines.CompletableDeferred
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
import java.io.File
import java.io.IOException

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

    @Test
    fun blankQueryShowsEverything() =
        runTest(dispatcher) {
            repo.emit(LibraryState(books = listOf(shelf("bk_a"), shelf("bk_b"))))
            advanceUntilIdle()
            assertEquals(2, vm.ui.value.visible.size)
        }

    @Test
    fun queryFiltersByTitleCaseInsensitively() =
        runTest(dispatcher) {
            repo.emit(LibraryState(books = listOf(shelf("bk_a"), shelf("bk_b"))))
            advanceUntilIdle()

            vm.onQueryChange("TITLE BK_B")
            advanceUntilIdle()
            assertEquals(listOf(shelf("bk_b")), vm.ui.value.visible)
            // The shelf itself is untouched — the filter is derived.
            assertEquals(2, vm.ui.value.books.size)
        }

    @Test
    fun queryFiltersByAuthorCaseInsensitively() =
        runTest(dispatcher) {
            val byAusten = shelf("bk_a").copy(author = "Jane Austen")
            val byJoyce = shelf("bk_b").copy(author = "James Joyce")
            repo.emit(LibraryState(books = listOf(byAusten, byJoyce)))
            advanceUntilIdle()

            vm.onQueryChange("austen")
            advanceUntilIdle()
            assertEquals(listOf(byAusten), vm.ui.value.visible)
        }

    @Test
    fun clearingTheQueryRestoresTheFullShelf() =
        runTest(dispatcher) {
            repo.emit(LibraryState(books = listOf(shelf("bk_a"), shelf("bk_b"))))
            advanceUntilIdle()

            vm.onQueryChange("bk_a")
            advanceUntilIdle()
            assertEquals(1, vm.ui.value.visible.size)

            vm.onQueryChange("")
            advanceUntilIdle()
            assertEquals(2, vm.ui.value.visible.size)
        }

    @Test
    fun aQueryMatchingNothingLeavesAnEmptyVisibleListOnAFullShelf() =
        runTest(dispatcher) {
            repo.emit(LibraryState(books = listOf(shelf("bk_a"))))
            advanceUntilIdle()

            vm.onQueryChange("zzz-no-match")
            advanceUntilIdle()
            val ui = vm.ui.value
            assertTrue(ui.visible.isEmpty())
            assertFalse(ui.books.isEmpty())
        }

    @Test
    fun retypingReDerivesTheVisibleListLive() =
        runTest(dispatcher) {
            val a = shelf("bk_alpha")
            val b = shelf("bk_beta")
            val c = shelf("bk_gamma")
            repo.emit(LibraryState(books = listOf(a, b, c)))
            advanceUntilIdle()

            vm.onQueryChange("a")
            advanceUntilIdle()
            assertEquals(3, vm.ui.value.visible.size)

            vm.onQueryChange("al")
            advanceUntilIdle()
            assertEquals(listOf(a), vm.ui.value.visible)

            vm.onQueryChange("gam")
            advanceUntilIdle()
            assertEquals(listOf(c), vm.ui.value.visible)
        }

    @Test
    fun aFinishedExportHandsTheFileToTheScreenAndClearsTheTransientState() =
        runTest(dispatcher) {
            var handed: File? = null
            vm.onExportAudio(shelf("bk_a")) { handed = it }
            advanceUntilIdle()
            assertEquals("/cache/exports/bk_a.opus", handed?.path)
            assertNull(vm.ui.value.exporting)
        }

    @Test
    fun preparingAudioBlocksDoubleTaps() =
        runTest(dispatcher) {
            val book = shelf("bk_a")
            val gate = CompletableDeferred<Unit>()
            repo.exportDelay = gate
            var ready = 0

            vm.onExportAudio(book) { ready++ }
            vm.onExportAudio(book) { ready++ }
            advanceUntilIdle()
            assertEquals(1, repo.exports.size)
            assertEquals(book, vm.ui.value.exporting)

            gate.complete(Unit)
            advanceUntilIdle()
            assertEquals(1, ready)
            assertNull(vm.ui.value.exporting)
        }

    @Test
    fun aFailedExportSurfacesAnErrorAndClearsTheTransientState() =
        runTest(dispatcher) {
            repo.exportResult = Result.failure(IOException("merge failed: text-only"))
            var ready = 0

            vm.onExportAudio(shelf("bk_a")) { ready++ }
            advanceUntilIdle()
            assertEquals(0, ready)
            assertEquals("merge failed: text-only", vm.ui.value.exportError)
            assertNull(vm.ui.value.exporting)

            vm.dismissExportError()
            assertNull(vm.ui.value.exportError)
        }

    private fun shelf(id: String) =
        BookShelf(
            bookId = id,
            title = "Title $id",
            author = null,
            chapterCount = 2,
            audioPresent = true,
            path = "/books/$id.taletrek",
        )

    private class FakeRepo : BooksRepo {
        private val _state = MutableStateFlow(LibraryState())
        override val state = _state.asStateFlow()

        var nextImport: ImportOutcome =
            ImportOutcome.Imported(BookShelf("bk_x", "X", null, 1, false, "/books/bk_x.taletrek"))
        val deleted = mutableListOf<BookShelf>()

        // Export controls: a gate for determinism, an override result
        // (unset = the canonical exports/ path for the book).
        var exportDelay: CompletableDeferred<Unit>? = null
        var exportResult: Result<File>? = null
        val exports = mutableListOf<BookShelf>()

        fun emit(state: LibraryState) {
            _state.value = state
        }

        override suspend fun refresh() {}

        override suspend fun importFrom(uri: String): ImportOutcome = nextImport

        override suspend fun delete(book: BookShelf) {
            deleted += book
        }

        override suspend fun exportAudio(book: BookShelf): File {
            exports += book
            exportDelay?.await()
            return exportResult?.getOrElse { throw it }
                ?: File("/cache/exports/${book.bookId}.opus")
        }
    }
}
