package dev.l1br3.taletrek

import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.data.BookSession
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.ffi.FfiPosition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The open/restore flow on device: a saved position seeds the session
 * paused at the saved paragraph (never auto-playing); a stray position
 * seeds fresh idle — the kernel glue's validation, exercised through the
 * real store + real kernel.
 */
@RunWith(AndroidJUnit4::class)
class RestoreFlowTest {
    @Test
    fun aSavedPositionOpensPausedAtTheSavedParagraph() =
        runBlocking {
            val (path, store) = fixture()
            store.save("bk_sample", FfiPosition(1u, 0u, 0.5))

            val session = withContext(Dispatchers.IO) { BookSession.open(context(), path, store) }

            assertEquals("bk_sample", session.book.bookId)
            val snap = session.kernel.snapshot()
            assertEquals(FfiPlayerStatus.PAUSED, snap.status)
            assertEquals(1u, snap.para?.chapter)
            assertEquals(0u, snap.para?.index)
            assertEquals(0.5, snap.offset, 0.0)
        }

    @Test
    fun anOutOfRangeSavedPositionOpensIdle() =
        runBlocking {
            val (path, store) = fixture()
            store.save("bk_sample", FfiPosition(9u, 9u, 1.0))

            val session = withContext(Dispatchers.IO) { BookSession.open(context(), path, store) }

            val snap = session.kernel.snapshot()
            assertEquals(FfiPlayerStatus.IDLE, snap.status)
            assertEquals(null, snap.para)
            assertEquals(null, session.kernel.position())
        }

    @Test
    fun noSavedPositionOpensFresh() =
        runBlocking {
            val (path, store) = fixture()

            val session = withContext(Dispatchers.IO) { BookSession.open(context(), path, store) }

            assertEquals(FfiPlayerStatus.IDLE, session.kernel.snapshot().status)
            assertTrue(session.bundleExists())
            assertEquals(
                3,
                session.book.chapters
                    .flatMap { it.paragraphs }
                    .size,
            )
        }

    private fun context() = InstrumentationRegistry.getInstrumentation().targetContext

    /** The playable fixture on disk + a store over a throwaway file. */
    private fun fixture(): Pair<String, PositionStore> {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val bundle =
            File(context.cacheDir, "restore-${System.nanoTime()}.taletrek").apply {
                instrumentation.context.assets.open("book-playable.taletrek").use { input ->
                    outputStream().use { output -> input.copyTo(output) }
                }
            }
        return bundle.absolutePath to testStore()
    }

    private fun testStore(): PositionStore {
        val context = context()
        val scope =
            kotlinx.coroutines.CoroutineScope(
                kotlinx.coroutines.SupervisorJob() + Dispatchers.IO,
            )
        val file = context.preferencesDataStoreFile("test_positions_restore_${System.nanoTime()}")
        return PositionStore(
            androidx.datastore.preferences.core.PreferenceDataStoreFactory
                .create(scope = scope) { file },
        )
    }
}
