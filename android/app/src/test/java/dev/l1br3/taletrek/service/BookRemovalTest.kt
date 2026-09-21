package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.data.BooksRepo
import dev.l1br3.taletrek.data.ImportOutcome
import dev.l1br3.taletrek.data.LibraryState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Delete-the-processing policy over fakes — deleting a book must take
 * everything working on it down too: the live job (cancel + await
 * terminal, else the drain seals the bundle back onto the shelf), the
 * pending marker + its staged source (else relaunch auto-resumes the
 * deleted book), and playback of that book. A foreign book's delete
 * touches none of it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BookRemovalTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var source: File
    private lateinit var store: PendingJobStore
    private val filling = MutableStateFlow<FillingBook?>(null)
    private val active = MutableStateFlow<SynthUiState?>(null)

    private val book = BookShelf("b1", "Title", null, 3, audioPresent = false, path = "/books/b1.taletrek")
    private val other = BookShelf("b2", "Other", null, 3, audioPresent = true, path = "/books/b2.taletrek")

    private var cancels = 0
    private var pauses = mutableListOf<String>()
    private lateinit var repo: FakeRepo

    @Before
    fun setUp() {
        source = tmp.newFile("import-source-1")
        source.writeText("staged source copy")
        store = PendingJobStore(tmp.newFolder())
        filling.value = null
        active.value = null
        cancels = 0
        pauses = mutableListOf()
        repo = FakeRepo()
    }

    private fun markerSaved() {
        store.save(
            PendingJobStore.PendingJob(
                request =
                    SynthJobRequest(
                        sourcePath = source.absolutePath,
                        hint = null,
                        voiceId = "v",
                        voiceCacheDir = "/vc",
                        espeakDir = "/es",
                        booksDir = "/books",
                        storeDir = "/store",
                        jobs = 2,
                        generatorApp = "taletrek-android",
                    ),
                preExistingBookPaths = emptyList(),
            ),
        )
    }

    private fun removal() =
        BookRemoval(
            repo = repo,
            pendingStore = store,
            filling = filling,
            active = active,
            requestCancel = { cancels++ },
            pausePlayback = { pauses += it },
        )

    @Test
    fun aLiveFillsDeleteCancelsThenSpendsMarkerSourceAndDeletes() =
        runTest {
            markerSaved()
            filling.value = FillingBook(book.path, book.bookId, FillPhase.Live)
            active.value = SynthUiState.Filling(10, 100)

            val job = launch { removal().remove(book) }
            // runCurrent (not advanceUntilIdle — that would fast-forward
            // through the bounded wait's timer): run to the suspension.
            runCurrent()

            // Suspended awaiting the job's terminal — cancel asked for,
            // nothing deleted yet (the drain would re-write the bundle).
            assertEquals(1, cancels)
            assertTrue(repo.deleted.isEmpty())
            assertTrue(source.isFile)

            active.value = SynthUiState.Cancelled
            advanceUntilIdle()
            assertTrue(job.isCompleted)

            assertNull(store.load())
            assertFalse(source.isFile)
            assertEquals(listOf(book), repo.deleted)
            assertEquals(listOf(book.path), pauses)
        }

    @Test
    fun aPausedFillsDeleteSpendsMarkerAndSourceWithoutCancelling() =
        runTest {
            markerSaved()
            store.stampTerminal(PendingTerminal.CANCELLED)
            filling.value = FillingBook(book.path, book.bookId, FillPhase.Paused(PendingTerminal.CANCELLED))
            active.value = SynthUiState.Cancelled

            removal().remove(book)
            advanceUntilIdle()

            assertEquals(0, cancels)
            assertNull(store.load())
            assertFalse(source.isFile)
            assertEquals(listOf(book), repo.deleted)
            assertEquals(listOf(book.path), pauses)
        }

    @Test
    fun aForeignFillsDeleteNeverCancelsOrSpendsAnotherBooksMarker() =
        runTest {
            markerSaved()
            filling.value = FillingBook(other.path, other.bookId, FillPhase.Live)
            active.value = SynthUiState.Filling(1, 10)

            removal().remove(book)
            advanceUntilIdle()

            assertEquals(0, cancels)
            assertTrue(store.load() != null)
            assertTrue(source.isFile)
            assertEquals(listOf(book), repo.deleted)
        }

    @Test
    fun aCancelThatNeverLandsStillDeletesAfterTheBoundedWait() =
        runTest {
            markerSaved()
            filling.value = FillingBook(book.path, book.bookId, FillPhase.Live)
            active.value = SynthUiState.Filling(50, 100)

            val job = launch { removal().remove(book) }
            runCurrent()
            assertEquals(1, cancels)
            assertTrue(repo.deleted.isEmpty())

            // No terminal ever arrives — the bounded wait gives up.
            advanceTimeBy(BookRemoval.CANCEL_LANDS_MS + 1L)
            advanceUntilIdle()
            assertTrue(job.isCompleted)

            assertNull(store.load())
            assertEquals(listOf(book), repo.deleted)
        }

    @Test
    fun aPlainBooksDeleteOnlyPausesPlaybackAndDeletes() =
        runTest {
            removal().remove(book)
            advanceUntilIdle()

            assertEquals(0, cancels)
            assertNull(store.load())
            assertEquals(listOf(book), repo.deleted)
            assertEquals(listOf(book.path), pauses)
        }

    private class FakeRepo : BooksRepo {
        override val state: Flow<LibraryState> = MutableStateFlow(LibraryState())

        override suspend fun refresh() {}

        override suspend fun importFrom(uri: String): ImportOutcome = ImportOutcome.Rejected("unused")

        val deleted = mutableListOf<BookShelf>()

        override suspend fun delete(book: BookShelf) {
            deleted += book
        }

        override suspend fun exportAudio(book: BookShelf): File = error("unused")
    }
}
