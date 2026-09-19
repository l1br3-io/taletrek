package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.service.SynthUiState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The library row's filling state — pure derivation, no Compose (the
 * rendering is dumb). A text-only row is "preparing audio" exactly when
 * a live job wrote it during this run (it appeared after the pending
 * marker's shelf snapshot); desktop-made text-only imports keep the
 * neutral row.
 */
class LibraryRowStateTest {
    private fun shelf(
        bookId: String = "bk_new",
        audio: Boolean = false,
        path: String = "/files/books/$bookId.taletrek",
    ) = BookShelf(bookId, "Title", null, 3, audio, path)

    @Test
    fun aFillingRowShowsPreparingAudioProgress() {
        val ui = fillingRowUi(shelf(), SynthUiState.Filling(4, 9), preExistingPaths = setOf("/files/books/bk_old.taletrek"))
        assertTrue(ui.filling)
        assertTrue(ui.detail!!.contains("4 of 9"))
    }

    @Test
    fun earlyPhasesShowPreparingWithoutCounts() {
        val preparing = fillingRowUi(shelf(), SynthUiState.Preparing(null, null), emptySet())
        val downloading = fillingRowUi(shelf(), SynthUiState.DownloadingVoice(10, 100), emptySet())
        val synthesizing = fillingRowUi(shelf(), SynthUiState.Synthesizing(1, 9), emptySet())
        assertTrue(preparing.filling)
        assertTrue(preparing.detail == null)
        assertTrue(downloading.filling)
        assertTrue(downloading.detail == null)
        assertTrue(synthesizing.filling)
        assertTrue(synthesizing.detail!!.contains("1 of 9"))
    }

    @Test
    fun theSealedRowIsTheNormalCompleteRow() {
        val ui = fillingRowUi(shelf(audio = true), SynthUiState.Done("bk_new", "/books/bk_new.taletrek"), emptySet())
        assertFalse(ui.filling)
    }

    @Test
    fun aDesktopTextOnlyImportKeepsTheNeutralRow() {
        val preExisting = fillingRowUi(shelf(), SynthUiState.Filling(4, 9), preExistingPaths = setOf("/files/books/bk_new.taletrek"))
        val idleJob = fillingRowUi(shelf(), SynthUiState.Done("bk_new", "/books/bk_new.taletrek"), emptySet())
        val noJob = fillingRowUi(shelf(), null, emptySet())
        assertFalse(preExisting.filling)
        assertFalse(idleJob.filling)
        assertFalse(noJob.filling)
    }

    @Test
    fun aTerminalJobDoesNotKeepRowsFilling() {
        val cancelled = fillingRowUi(shelf(), SynthUiState.Cancelled, emptySet())
        val failed = fillingRowUi(shelf(), SynthUiState.Failed("resolve", "down"), emptySet())
        assertFalse(cancelled.filling)
        assertFalse(failed.filling)
    }

    @Test
    fun theConvertCardHidesOnceTheFillingRowExists() {
        // Before the row exists (parse, voice download) the card is the
        // only feedback — every running phase shows it.
        assertTrue(
            convertCardVisible(SynthUiState.DownloadingVoice(1, 100), fillingRowOnShelf = false, terminalDismissed = false),
        )
        assertTrue(
            convertCardVisible(SynthUiState.Preparing(null, null), fillingRowOnShelf = false, terminalDismissed = false),
        )
        // Once the job's row is on the shelf, the card hides — one row
        // per book.
        assertFalse(
            convertCardVisible(SynthUiState.Filling(2, 9), fillingRowOnShelf = true, terminalDismissed = false),
        )
        assertFalse(
            convertCardVisible(SynthUiState.Writing, fillingRowOnShelf = true, terminalDismissed = false),
        )
    }

    @Test
    fun theConvertCardTerminalLingersUntilDismissed() {
        // Terminal feedback stays (even when the row exists) until the
        // user dismisses; nothing shows for no job or idle.
        assertTrue(
            convertCardVisible(SynthUiState.Done("bk", "/books/bk.taletrek"), fillingRowOnShelf = true, terminalDismissed = false),
        )
        assertTrue(
            convertCardVisible(SynthUiState.Failed("parse", "bad doc"), fillingRowOnShelf = false, terminalDismissed = false),
        )
        assertFalse(
            convertCardVisible(SynthUiState.Done("bk", "/books/bk.taletrek"), fillingRowOnShelf = false, terminalDismissed = true),
        )
        assertFalse(convertCardVisible(null, fillingRowOnShelf = false, terminalDismissed = false))
        assertFalse(convertCardVisible(SynthUiState.Idle, fillingRowOnShelf = false, terminalDismissed = false))
    }
}
