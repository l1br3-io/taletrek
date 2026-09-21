package dev.l1br3.taletrek.ui.reader

import dev.l1br3.taletrek.ffi.FfiParagraphPos
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.playback.SessionState
import dev.l1br3.taletrek.service.FillPhase
import dev.l1br3.taletrek.service.FillingBook
import dev.l1br3.taletrek.service.PendingTerminal
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The reader's sync loop over fakes — the JVM half of the split (real
 * service + real broadcasts on device, in ReaderSyncTest). The bars
 * that matter: snapshots flow into render state, following defers to
 * the user and resumes on the next paragraph, taps are pure
 * SeekToParagraph forwards, and no sequencing is computed here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ReaderViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val transport = FakeTransport()
    private val fill = MutableStateFlow<FillingBook?>(null)
    private val jobState = MutableStateFlow<SynthUiState?>(null)
    private lateinit var vm: ReaderViewModel

    private fun liveFor(path: String) = FillingBook(path, "bk_sample", FillPhase.Live)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun openingRendersTheRestoredChapterAndTellsTheTransportToOpen() =
        runTest(dispatcher) {
            vm = ReaderViewModel(opener = { book(initialChapter = 1) }, transport = transport)
            advanceUntilIdle()
            assertEquals(1, vm.ui.value.renderedChapter)
            assertEquals(listOf("/books/bk_sample.taletrek"), transport.opened)
        }

    @Test
    fun anUnopenableBookIsMissingNotACrash() =
        runTest(dispatcher) {
            vm = ReaderViewModel(opener = { null }, transport = transport)
            advanceUntilIdle()
            assertTrue(vm.ui.value.missing)
            assertTrue(transport.opened.isEmpty())
        }

    @Test
    fun snapshotsForThisBookFlowIntoRenderState() =
        runTest(dispatcher) {
            vm = opened()
            transport.emit(playing(para(1, 0)))
            advanceUntilIdle()

            assertEquals(FfiPlayerStatus.PLAYING, vm.ui.value.status)
            assertEquals(para(1, 0), vm.ui.value.active)
            assertEquals(1, vm.ui.value.renderedChapter)
            assertTrue(vm.ui.value.follow)
        }

    @Test
    fun snapshotsForAnotherBookAreIgnored() =
        runTest(dispatcher) {
            vm = opened()
            transport.emit(playing(para(1, 0)).copy(bookId = "bk_other"))
            advanceUntilIdle()
            assertEquals(null, vm.ui.value.active)
            assertEquals(0, vm.ui.value.renderedChapter)
        }

    @Test
    fun aUserScrollDefersFollowingUntilTheNextParagraph() =
        runTest(dispatcher) {
            vm = opened()
            transport.emit(playing(para(0, 0)))
            advanceUntilIdle()

            vm.onUserScrolled()
            assertFalse(vm.ui.value.follow)

            // The next paragraph re-arms following (the task's locked
            // resume rule — simpler than the desktop's re-entry rule)
            // and the pane tracks the spoken chapter again.
            transport.emit(playing(para(0, 1)))
            advanceUntilIdle()
            assertTrue(vm.ui.value.follow)
            assertEquals(0, vm.ui.value.renderedChapter)

            transport.emit(playing(para(1, 0)))
            advanceUntilIdle()
            assertEquals(1, vm.ui.value.renderedChapter)
        }

    @Test
    fun aParagraphTapForwardsASeekAndReArmsFollowing() =
        runTest(dispatcher) {
            vm = opened()
            vm.onUserScrolled()

            vm.onParagraphTapped(2)

            assertEquals(listOf(0u to 2u), transport.seeks)
            assertTrue(vm.ui.value.follow)
        }

    @Test
    fun outlineJumpSeeksTheChapterStartAndSwitchesTheRender() =
        runTest(dispatcher) {
            vm = opened()

            vm.jumpToChapter(1)

            assertEquals(1, vm.ui.value.renderedChapter)
            assertEquals(listOf(1u to 0u), transport.seeks)
        }

    @Test
    fun jumpingToTheCurrentChapterRestartsItAtItsStart() =
        runTest(dispatcher) {
            vm = opened()

            vm.jumpToChapter(0)

            assertEquals(0, vm.ui.value.renderedChapter)
            assertEquals(listOf(0u to 0u), transport.seeks)
        }

    @Test
    fun anOutOfBoundsJumpIsIgnored() =
        runTest(dispatcher) {
            vm = opened()

            vm.jumpToChapter(2)
            vm.jumpToChapter(-1)

            assertEquals(0, vm.ui.value.renderedChapter)
            assertTrue(transport.seeks.isEmpty())
        }

    @Test
    fun transportButtonsForwardAsPlainCommands() =
        runTest(dispatcher) {
            vm = opened()

            vm.play()
            vm.pause()
            vm.nextParagraph()
            vm.prevParagraph()
            vm.nextChapter()
            vm.prevChapter()

            assertEquals(listOf("play", "pause", "nextParagraph", "prevParagraph", "nextChapter", "prevChapter"), transport.commands)
        }

    @Test
    fun transportEnabledStateDerivesFromTheSnapshot() =
        runTest(dispatcher) {
            vm = opened()

            // No paragraph yet: navigation is inert, play is not.
            var t = vm.ui.value.transport
            assertFalse(t.canPrevParagraph)
            assertFalse(t.canNextParagraph)
            assertFalse(t.playing)
            assertTrue(t.canPlayPause)

            // Book start.
            transport.emit(playing(para(0, 0)))
            advanceUntilIdle()
            t = vm.ui.value.transport
            assertTrue(t.playing)
            assertFalse(t.canPrevParagraph)
            assertFalse(t.canPrevChapter)
            assertTrue(t.canNextParagraph)
            assertTrue(t.canNextChapter)

            // Book end (ch1 has one paragraph).
            transport.emit(playing(para(1, 0)))
            advanceUntilIdle()
            t = vm.ui.value.transport
            assertFalse(t.canNextParagraph)
            assertFalse(t.canNextChapter)
            assertTrue(t.canPrevParagraph)
            assertTrue(t.canPrevChapter)
        }

    @Test
    fun aTextOnlyBookDisablesTheWholeTransport() =
        runTest(dispatcher) {
            vm = ReaderViewModel(opener = { book(initialChapter = 0, audio = false) }, transport = transport)
            advanceUntilIdle()
            transport.emit(playing(para(0, 0)))
            advanceUntilIdle()

            val t = vm.ui.value.transport
            assertFalse(t.canPlayPause)
            assertFalse(t.canPrevParagraph)
            assertFalse(t.canNextParagraph)
            assertFalse(t.canPrevChapter)
            assertFalse(t.canNextChapter)
        }

    @Test
    fun openingAFillingBookAtItsStoredPositionAnchorsSynthesisThere() =
        runTest(dispatcher) {
            fill.value = liveFor("/books/bk_sample.taletrek")
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 1, audio = false, initialPos = para(1, 0)) },
                    transport = transport,
                    filling = fill,
                )
            advanceUntilIdle()

            assertEquals(listOf(1u to 0u), transport.reanchors)
            assertTrue("a filling book is playable", vm.ui.value.transport.canPlayPause)
        }

    @Test
    fun aFillingBookWithoutAStoredPositionAnchorsAtTheRenderedStart() =
        runTest(dispatcher) {
            fill.value = liveFor("/books/bk_sample.taletrek")
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                )
            advanceUntilIdle()

            assertEquals(listOf(0u to 0u), transport.reanchors)
        }

    @Test
    fun openedBeforeTheJobArmsWhenThisBooksFillGoesLive() =
        runTest(dispatcher) {
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                )
            advanceUntilIdle()
            assertFalse(vm.ui.value.transport.canPlayPause)

            fill.value = liveFor("/books/bk_sample.taletrek")
            advanceUntilIdle()

            assertTrue("armed by the live fill", vm.ui.value.transport.canPlayPause)
            assertEquals(listOf(0u to 0u), transport.reanchors)
        }

    @Test
    fun lateArmingReanchorsAtTheRenderedPosition() =
        runTest(dispatcher) {
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                )
            advanceUntilIdle()

            vm.jumpToChapter(1)
            fill.value = liveFor("/books/bk_sample.taletrek")
            advanceUntilIdle()

            assertEquals(listOf(1u to 0u), transport.reanchors)
        }

    @Test
    fun anotherBooksFillNeverArmsThisSession() =
        runTest(dispatcher) {
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                )
            advanceUntilIdle()

            fill.value = liveFor("/books/bk_other.taletrek")
            advanceUntilIdle()

            assertFalse(vm.ui.value.transport.canPlayPause)
            vm.onParagraphTapped(2)
            assertTrue(transport.reanchors.isEmpty())
        }

    @Test
    fun aPausedFillNeverArmsTheSession() =
        runTest(dispatcher) {
            fill.value =
                FillingBook(
                    "/books/bk_sample.taletrek",
                    "bk_sample",
                    FillPhase.Paused(PendingTerminal.CANCELLED),
                )
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                )
            advanceUntilIdle()

            assertFalse(vm.ui.value.transport.canPlayPause)
            assertTrue(transport.reanchors.isEmpty())
        }

    @Test
    fun armingIsStickyThroughTheSeal() =
        runTest(dispatcher) {
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                )
            fill.value = liveFor("/books/bk_sample.taletrek")
            advanceUntilIdle()
            assertTrue(vm.ui.value.transport.canPlayPause)

            // Done: the flow goes null — the session stays armed (sealed
            // reads answer Ready from the bundle from then on).
            fill.value = null
            advanceUntilIdle()
            assertTrue(vm.ui.value.transport.canPlayPause)

            vm.onParagraphTapped(2)
            assertEquals(listOf(0u to 0u, 0u to 2u), transport.reanchors)
        }

    @Test
    fun seekingWhileFillingReanchorsSynthesisAtThePlayhead() =
        runTest(dispatcher) {
            fill.value = liveFor("/books/bk_sample.taletrek")
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                )
            advanceUntilIdle()

            vm.onParagraphTapped(2)
            vm.jumpToChapter(1)

            assertEquals(listOf(0u to 0u, 0u to 2u, 1u to 0u), transport.reanchors)
        }

    @Test
    fun seekingANarratedBookNeverAnchorsSynthesis() =
        runTest(dispatcher) {
            vm = opened()
            vm.onParagraphTapped(2)
            assertTrue(transport.reanchors.isEmpty())
        }

    @Test
    fun bufferingMapsIntoDisabledTransportAndRecovers() =
        runTest(dispatcher) {
            vm = opened()
            transport.emit(playing(para(0, 0)).copy(buffering = true))
            advanceUntilIdle()

            var t = vm.ui.value.transport
            assertTrue(t.buffering)
            assertFalse(t.canPlayPause)
            assertFalse(t.canNextParagraph)

            transport.emit(playing(para(0, 0)).copy(buffering = false))
            advanceUntilIdle()
            t = vm.ui.value.transport
            assertFalse(t.buffering)
            assertTrue(t.canPlayPause)
        }

    @Test
    fun aStalledLoadWithADeadJobSurfacesTheResumeAffordance() =
        runTest(dispatcher) {
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0) },
                    transport = transport,
                    onResumeSynth = { transport.commands += "resumeSynth" },
                )
            transport.emit(playing(para(0, 0)).copy(stalled = true))
            advanceUntilIdle()

            val t = vm.ui.value.transport
            assertTrue(t.stalled)
            assertFalse(t.canPlayPause)

            vm.resumeAudio()
            assertEquals(listOf("resumeSynth", "retryLoad"), transport.commands)
        }

    @Test
    fun bufferingMirrorsTheLiveJobForThisBook() =
        runTest(dispatcher) {
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                    jobState = jobState,
                )
            advanceUntilIdle()
            fill.value = liveFor("/books/bk_sample.taletrek")
            jobState.value = SynthUiState.DownloadingVoice(12L * 1024 * 1024, 63L * 1024 * 1024)
            transport.emit(playing(para(0, 0)).copy(buffering = true))
            advanceUntilIdle()

            assertEquals("Downloading voice 12 of 63 MB", vm.ui.value.transport.bufferingDetail)

            jobState.value = SynthUiState.Filling(24, 210)
            advanceUntilIdle()
            assertEquals("Preparing audio · 24 of 210 paragraphs", vm.ui.value.transport.bufferingDetail)
        }

    @Test
    fun bufferingWithoutThisBooksFillIsThePlainLine() =
        runTest(dispatcher) {
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                    jobState = jobState,
                )
            jobState.value = SynthUiState.Filling(24, 210)
            transport.emit(playing(para(0, 0)).copy(buffering = true))
            advanceUntilIdle()

            assertNull(vm.ui.value.transport.bufferingDetail)
        }

    @Test
    fun theDetailClearsWithTheBuffer() =
        runTest(dispatcher) {
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                    jobState = jobState,
                )
            fill.value = liveFor("/books/bk_sample.taletrek")
            jobState.value = SynthUiState.Filling(24, 210)
            transport.emit(playing(para(0, 0)).copy(buffering = true))
            advanceUntilIdle()
            assertNotNull(vm.ui.value.transport.bufferingDetail)

            transport.emit(playing(para(0, 0)).copy(buffering = false))
            advanceUntilIdle()
            assertNull(vm.ui.value.transport.bufferingDetail)
        }

    @Test
    fun aFailedFillsResumeReadsRetry() =
        runTest(dispatcher) {
            fill.value =
                FillingBook(
                    "/books/bk_sample.taletrek",
                    "bk_sample",
                    FillPhase.Paused(PendingTerminal.FAILED),
                )
            vm =
                ReaderViewModel(
                    opener = { book(initialChapter = 0, audio = false) },
                    transport = transport,
                    filling = fill,
                )
            advanceUntilIdle()
            transport.emit(playing(para(0, 0)).copy(stalled = true))
            advanceUntilIdle()

            assertEquals("Retry preparing audio", vm.ui.value.transport.resumeLabel)
        }

    private suspend fun TestScope.opened(): ReaderViewModel {
        val vm = ReaderViewModel(opener = { book(initialChapter = 0) }, transport = transport)
        advanceUntilIdle()
        return vm
    }

    private fun book(
        initialChapter: Int,
        audio: Boolean = true,
        initialPos: FfiParagraphPos? = null,
    ) = OpenedBook(
        title = "Sample Book",
        bookId = "bk_sample",
        audioPresent = audio,
        path = "/books/bk_sample.taletrek",
        chapters =
            listOf(
                ReaderChapter("Chapter One", listOf("Hello world.", "The quick brown fox jumps over the lazy dog.")),
                ReaderChapter("Chapter Two", listOf("O’Reilly books are well worth reading.")),
            ),
        initialChapter = initialChapter,
        initialPos = initialPos,
    )

    private fun para(
        chapter: Int,
        index: Int,
    ): FfiParagraphPos = FfiParagraphPos(chapter.toUInt(), index.toUInt())

    private fun playing(
        para: FfiParagraphPos?,
        skipped: UInt = 0u,
    ) = SessionState(
        status = FfiPlayerStatus.PLAYING,
        para = para,
        offset = 0.0,
        skipped = skipped,
        lastError = null,
        bookId = "bk_sample",
        audioPresent = true,
    )

    private class FakeTransport : ReaderTransport {
        val opened = mutableListOf<String>()
        val commands = mutableListOf<String>()
        val seeks = mutableListOf<Pair<UInt, UInt>>()
        val reanchors = mutableListOf<Pair<UInt, UInt>>()
        private val _states = MutableStateFlow(SessionState(FfiPlayerStatus.IDLE, null, 0.0, 0u, null, null, true))
        override val states = _states.asStateFlow()

        fun emit(state: SessionState) {
            _states.value = state
        }

        override fun openBook(path: String) {
            opened += path
        }

        override fun play() {
            commands += "play"
        }

        override fun pause() {
            commands += "pause"
        }

        override fun nextParagraph() {
            commands += "nextParagraph"
        }

        override fun prevParagraph() {
            commands += "prevParagraph"
        }

        override fun nextChapter() {
            commands += "nextChapter"
        }

        override fun prevChapter() {
            commands += "prevChapter"
        }

        override fun seekToParagraph(
            chapter: UInt,
            index: UInt,
        ) {
            seeks += chapter to index
        }

        override fun reanchor(
            chapter: UInt,
            index: UInt,
        ) {
            reanchors += chapter to index
        }

        override fun retryLoad() {
            commands += "retryLoad"
        }
    }
}
