package dev.l1br3.taletrek

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.ffi.openBook
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class FfiSmokeTest {
    @Test
    fun openBookReadsTheFixtureOnDevice() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bundle =
            File(instrumentation.targetContext.cacheDir, "book-full.taletrek").apply {
                instrumentation.context.assets.open("book-full.taletrek").use { input ->
                    outputStream().use { output -> input.copyTo(output) }
                }
            }

        val book = openBook(bundle.absolutePath)

        assertEquals("bk_sample", book.bookId)
        assertEquals("Sample Book", book.title)
        assertTrue(book.audioPresent)
        assertEquals(2, book.chapters.size)
        assertEquals("Chapter One", book.chapters.first().title)
        assertEquals(
            2,
            book.chapters
                .first()
                .paragraphs.size,
        )
    }
}
