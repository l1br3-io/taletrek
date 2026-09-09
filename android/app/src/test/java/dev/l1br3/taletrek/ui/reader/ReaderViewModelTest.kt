package dev.l1br3.taletrek.ui.reader

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
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
 * The reader's chapter-state logic over fakes — the JVM half of the
 * spec's split (opening a real bundle needs the kernel `.so`; that
 * walk is instrumented, in ReaderScreenTest). The bar from the task:
 * the ViewModel renders state and forwards jump intents; any
 * next/prev arithmetic lives in the kernel, never here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ReaderViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val seeker = RecordingSeeker()
    private lateinit var vm: ReaderViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun openingRendersTheRestoredChapterNotAlwaysTheFirst() =
        runTest(dispatcher) {
            vm = ReaderViewModel(opener = { book(initialChapter = 1) }, seeker = seeker)
            advanceUntilIdle()
            assertEquals(1, vm.ui.value.renderedChapter)
            assertEquals(
                "Chapter Two",
                vm.ui.value.chapters[vm.ui.value.renderedChapter]
                    .title,
            )
            assertFalse(vm.ui.value.missing)
        }

    @Test
    fun anUnopenableBookIsMissingNotACrash() =
        runTest(dispatcher) {
            vm = ReaderViewModel(opener = { null }, seeker = seeker)
            advanceUntilIdle()
            assertTrue(vm.ui.value.missing)
            assertTrue(
                vm.ui.value.chapters
                    .isEmpty(),
            )
        }

    @Test
    fun outlineJumpSwitchesTheRenderedChapterAndSeeksItsStart() =
        runTest(dispatcher) {
            vm = ReaderViewModel(opener = { book(initialChapter = 0) }, seeker = seeker)
            advanceUntilIdle()

            vm.jumpToChapter(1)

            assertEquals(1, vm.ui.value.renderedChapter)
            assertEquals(listOf(1u), seeker.chapterStarts)
        }

    @Test
    fun jumpingToTheCurrentChapterRestartsItAtItsStart() =
        runTest(dispatcher) {
            vm = ReaderViewModel(opener = { book(initialChapter = 0) }, seeker = seeker)
            advanceUntilIdle()

            vm.jumpToChapter(0)

            assertEquals(0, vm.ui.value.renderedChapter)
            assertEquals(listOf(0u), seeker.chapterStarts)
        }

    @Test
    fun anOutOfBoundsJumpIsIgnored() =
        runTest(dispatcher) {
            vm = ReaderViewModel(opener = { book(initialChapter = 0) }, seeker = seeker)
            advanceUntilIdle()

            vm.jumpToChapter(2)
            vm.jumpToChapter(-1)

            assertEquals(0, vm.ui.value.renderedChapter)
            assertNull(seeker.chapterStarts.lastOrNull())
            assertTrue(seeker.chapterStarts.isEmpty())
        }

    private fun book(initialChapter: Int) =
        OpenedBook(
            title = "Sample Book",
            audioPresent = false,
            path = "/books/bk_sample.taletrek",
            chapters =
                listOf(
                    ReaderChapter("Chapter One", listOf("Hello world.", "The quick brown fox jumps over the lazy dog.")),
                    ReaderChapter("Chapter Two", listOf("O’Reilly books are well worth reading.")),
                ),
            initialChapter = initialChapter,
        )

    private class RecordingSeeker : ChapterSeeker {
        val chapterStarts = mutableListOf<UInt>()

        override fun seekToChapterStart(chapter: UInt) {
            chapterStarts += chapter
        }
    }
}
