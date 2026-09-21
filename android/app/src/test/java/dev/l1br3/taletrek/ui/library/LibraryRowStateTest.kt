package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.service.FillPhase
import dev.l1br3.taletrek.service.FillingBook
import dev.l1br3.taletrek.service.PendingTerminal
import dev.l1br3.taletrek.service.SynthUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The library row's fill state — pure derivation from the monitor (the
 * rendering is dumb). A row is filling exactly when the live fill
 * targets it; a paused fill (cancelled/failed marker) is the recovery
 * row; everything else — desktop text-only imports included — keeps the
 * neutral row.
 */
class LibraryRowStateTest {
    private fun shelf(
        bookId: String = "bk_new",
        audio: Boolean = false,
        path: String = "/files/books/$bookId.taletrek",
    ) = BookShelf(bookId, "Title", null, 3, audio, path)

    private fun fill(
        path: String,
        phase: FillPhase = FillPhase.Live,
    ) = FillingBook(path, path.substringAfterLast("/").removeSuffix(".taletrek"), phase)

    @Test
    fun aFillingRowShowsPreparingAudioProgress() {
        val ui = fillingRowUi(shelf(), fill("/files/books/bk_new.taletrek"), SynthUiState.Filling(4, 9))
        assertTrue(ui.filling)
        assertTrue(ui.detail!!.contains("4 of 9"))
        assertFalse(ui.paused)
    }

    @Test
    fun earlyPhasesShowPreparingWithoutCounts() {
        val preparing = fillingRowUi(shelf(), fill("/files/books/bk_new.taletrek"), SynthUiState.Preparing(null, null))
        val downloading = fillingRowUi(shelf(), fill("/files/books/bk_new.taletrek"), SynthUiState.DownloadingVoice(10, 100))
        val synthesizing = fillingRowUi(shelf(), fill("/files/books/bk_new.taletrek"), SynthUiState.Synthesizing(1, 9))
        assertTrue(preparing.filling)
        assertNull(preparing.detail)
        assertTrue(downloading.filling)
        assertNull(downloading.detail)
        assertTrue(synthesizing.filling)
        assertTrue(synthesizing.detail!!.contains("1 of 9"))
    }

    @Test
    fun aPausedFillIsTheRecoveryRow() {
        val cancelled =
            fillingRowUi(shelf(), fill("/files/books/bk_new.taletrek", FillPhase.Paused(PendingTerminal.CANCELLED)), null)
        val failed =
            fillingRowUi(shelf(), fill("/files/books/bk_new.taletrek", FillPhase.Paused(PendingTerminal.FAILED)), null)
        assertTrue(cancelled.paused)
        assertFalse(cancelled.filling)
        assertTrue(failed.paused)
        assertFalse(failed.filling)
    }

    @Test
    fun anotherBooksFillNeverMarksThisRow() {
        val ui = fillingRowUi(shelf(), fill("/files/books/bk_other.taletrek"), SynthUiState.Filling(4, 9))
        assertFalse(ui.filling)
        assertFalse(ui.paused)
    }

    @Test
    fun theSealedRowIsTheNormalCompleteRow() {
        val ui =
            fillingRowUi(shelf(audio = true), fill("/files/books/bk_new.taletrek"), SynthUiState.Done("bk_new", "/books/bk_new.taletrek"))
        assertFalse(ui.filling)
        assertFalse(ui.paused)
    }

    @Test
    fun noFillAtAllKeepsTheNeutralRow() {
        val ui = fillingRowUi(shelf(), null, null)
        assertFalse(ui.filling)
        assertFalse(ui.paused)
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
        assertEquals(false, convertCardVisible(SynthUiState.Idle, fillingRowOnShelf = false, terminalDismissed = false))
    }
}
