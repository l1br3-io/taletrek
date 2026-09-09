package dev.l1br3.taletrek.playback

import android.os.Bundle
import androidx.media3.session.SessionCommand

/**
 * The session's custom commands — paragraph-granular transport (the
 * notification's prev/next ride the standard chapter-granularity commands
 * per the spec) plus book-open and state polling for the debug screen
 * (005/007 replace the polling with real observation).
 */
object SessionCommands {
    const val ACTION_OPEN_BOOK = "dev.l1br3.taletrek.action.OPEN_BOOK"
    const val ACTION_NEXT_PARAGRAPH = "dev.l1br3.taletrek.action.NEXT_PARAGRAPH"
    const val ACTION_PREV_PARAGRAPH = "dev.l1br3.taletrek.action.PREV_PARAGRAPH"
    const val ACTION_SEEK_PARAGRAPH = "dev.l1br3.taletrek.action.SEEK_PARAGRAPH"
    const val ACTION_GET_STATE = "dev.l1br3.taletrek.action.GET_STATE"

    val OPEN_BOOK = SessionCommand(ACTION_OPEN_BOOK, Bundle.EMPTY)
    val NEXT_PARAGRAPH = SessionCommand(ACTION_NEXT_PARAGRAPH, Bundle.EMPTY)
    val PREV_PARAGRAPH = SessionCommand(ACTION_PREV_PARAGRAPH, Bundle.EMPTY)
    val SEEK_PARAGRAPH = SessionCommand(ACTION_SEEK_PARAGRAPH, Bundle.EMPTY)
    val GET_STATE = SessionCommand(ACTION_GET_STATE, Bundle.EMPTY)

    val ALL = listOf(OPEN_BOOK, NEXT_PARAGRAPH, PREV_PARAGRAPH, SEEK_PARAGRAPH, GET_STATE)

    const val EXTRA_PATH = "path"
    const val EXTRA_CHAPTER = "chapter"
    const val EXTRA_INDEX = "index"

    // GET_STATE reply keys.
    const val STATE_STATUS = "status"
    const val STATE_CHAPTER = "chapter"
    const val STATE_INDEX = "index"
    const val STATE_OFFSET = "offset"
    const val STATE_SKIPPED = "skipped"
    const val STATE_BOOK_ID = "bookId"
    const val STATE_AUDIO_PRESENT = "audioPresent"

    /** An empty-book state (no book open yet). */
    fun emptyStateBundle(): Bundle =
        Bundle().apply {
            putString(STATE_STATUS, "None")
            putLong(STATE_CHAPTER, -1L)
        }
}
