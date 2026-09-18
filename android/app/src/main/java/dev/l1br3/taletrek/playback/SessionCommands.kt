package dev.l1br3.taletrek.playback

import android.os.Bundle
import androidx.media3.session.SessionCommand
import dev.l1br3.taletrek.ffi.FfiParagraphPos
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.ffi.FfiStateSnapshot

/**
 * The session's custom commands — paragraph-granular transport (the
 * notification's prev/next ride the standard chapter-granularity
 * commands per the spec), book-open, and the state channel: GET_STATE
 * for the initial read, STATE_BROADCAST for the push (one broadcast
 * per kernel transition; the reader's highlight rides it).
 */
object SessionCommands {
    const val ACTION_OPEN_BOOK = "dev.l1br3.taletrek.action.OPEN_BOOK"
    const val ACTION_NEXT_PARAGRAPH = "dev.l1br3.taletrek.action.NEXT_PARAGRAPH"
    const val ACTION_PREV_PARAGRAPH = "dev.l1br3.taletrek.action.PREV_PARAGRAPH"
    const val ACTION_SEEK_PARAGRAPH = "dev.l1br3.taletrek.action.SEEK_PARAGRAPH"
    const val ACTION_REANCHOR = "dev.l1br3.taletrek.action.REANCHOR"
    const val ACTION_RETRY_LOAD = "dev.l1br3.taletrek.action.RETRY_LOAD"
    const val ACTION_GET_STATE = "dev.l1br3.taletrek.action.GET_STATE"
    const val ACTION_STATE_BROADCAST = "dev.l1br3.taletrek.action.STATE_BROADCAST"

    val OPEN_BOOK = SessionCommand(ACTION_OPEN_BOOK, Bundle.EMPTY)
    val NEXT_PARAGRAPH = SessionCommand(ACTION_NEXT_PARAGRAPH, Bundle.EMPTY)
    val PREV_PARAGRAPH = SessionCommand(ACTION_PREV_PARAGRAPH, Bundle.EMPTY)
    val SEEK_PARAGRAPH = SessionCommand(ACTION_SEEK_PARAGRAPH, Bundle.EMPTY)
    val REANCHOR = SessionCommand(ACTION_REANCHOR, Bundle.EMPTY)
    val RETRY_LOAD = SessionCommand(ACTION_RETRY_LOAD, Bundle.EMPTY)
    val GET_STATE = SessionCommand(ACTION_GET_STATE, Bundle.EMPTY)
    val STATE_BROADCAST = SessionCommand(ACTION_STATE_BROADCAST, Bundle.EMPTY)

    val ALL =
        listOf(
            OPEN_BOOK,
            NEXT_PARAGRAPH,
            PREV_PARAGRAPH,
            SEEK_PARAGRAPH,
            REANCHOR,
            RETRY_LOAD,
            GET_STATE,
            STATE_BROADCAST,
        )

    const val EXTRA_PATH = "path"
    const val EXTRA_CHAPTER = "chapter"
    const val EXTRA_INDEX = "index"

    // State payload keys (GET_STATE replies + STATE_BROADCAST extras).
    const val STATE_STATUS = "status"
    const val STATE_CHAPTER = "chapter"
    const val STATE_INDEX = "index"
    const val STATE_OFFSET = "offset"
    const val STATE_SKIPPED = "skipped"
    const val STATE_LAST_ERROR = "lastError"
    const val STATE_BOOK_ID = "bookId"
    const val STATE_AUDIO_PRESENT = "audioPresent"
    const val STATE_BUFFERING = "buffering"
    const val STATE_STALLED = "stalled"

    /** An empty-book state (no book open yet). */
    fun emptyStateBundle(): Bundle =
        Bundle().apply {
            putString(STATE_STATUS, "None")
            putLong(STATE_CHAPTER, -1L)
        }
}

/**
 * The session's state as the UI sees it — the reader's whole window
 * into playback. Plain data, kernel-authored, UI-rendered.
 */
data class SessionState(
    val status: FfiPlayerStatus,
    val para: FfiParagraphPos?,
    val offset: Double,
    val skipped: UInt,
    val lastError: String?,
    val bookId: String?,
    val audioPresent: Boolean,
    val buffering: Boolean = false,
    val stalled: Boolean = false,
) {
    companion object {
        /** Parse the wire bundle (GET_STATE reply or STATE_BROADCAST extras). */
        fun fromBundle(extras: Bundle): SessionState {
            val chapter = extras.getLong(SessionCommands.STATE_CHAPTER, -1L)
            val bookId = extras.getString(SessionCommands.STATE_BOOK_ID)
            return SessionState(
                status =
                    when (extras.getString(SessionCommands.STATE_STATUS)) {
                        "Playing" -> FfiPlayerStatus.PLAYING
                        "Paused" -> FfiPlayerStatus.PAUSED
                        "Idle" -> FfiPlayerStatus.IDLE
                        else -> FfiPlayerStatus.IDLE // "None": no session yet
                    },
                para =
                    if (chapter < 0) {
                        null
                    } else {
                        FfiParagraphPos(chapter.toUInt(), extras.getLong(SessionCommands.STATE_INDEX, 0L).toUInt())
                    },
                offset = extras.getDouble(SessionCommands.STATE_OFFSET, 0.0),
                skipped = extras.getLong(SessionCommands.STATE_SKIPPED, 0L).toUInt(),
                lastError = extras.getString(SessionCommands.STATE_LAST_ERROR),
                bookId = bookId,
                audioPresent = extras.getBoolean(SessionCommands.STATE_AUDIO_PRESENT, true),
                buffering = extras.getBoolean(SessionCommands.STATE_BUFFERING, false),
                stalled = extras.getBoolean(SessionCommands.STATE_STALLED, false),
            )
        }

        fun fromSnapshot(
            snapshot: FfiStateSnapshot,
            bookId: String,
            audioPresent: Boolean,
            buffering: Boolean = false,
            stalled: Boolean = false,
        ): SessionState =
            SessionState(
                status = snapshot.status,
                para = snapshot.para,
                offset = snapshot.offset,
                skipped = snapshot.failures.skipped,
                lastError = snapshot.failures.lastError,
                bookId = bookId,
                audioPresent = audioPresent,
                buffering = buffering,
                stalled = stalled,
            )
    }
}
