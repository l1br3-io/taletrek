package dev.l1br3.taletrek.ui.reader

import android.content.Context
import android.os.Bundle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.media3.session.MediaController
import dev.l1br3.taletrek.data.BookSession
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.playback.SessionCommands
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One rendered chapter — the reader never holds the whole book at once. */
data class ReaderChapter(
    val title: String,
    val paragraphs: List<String>,
)

/** What opening a book for reading yields (text data + where to start). */
data class OpenedBook(
    val title: String,
    val audioPresent: Boolean,
    val path: String,
    val chapters: List<ReaderChapter>,
    val initialChapter: Int,
)

/**
 * A chapter jump forwarded to the session (the service's kernel, via
 * its SEEK command). Chapter starts are chapter facts, not paragraph
 * arithmetic — no next/prev logic ever lives on this side.
 */
fun interface ChapterSeeker {
    fun seekToChapterStart(chapter: UInt)
}

/** The reader screen's render state — Compose renders this, nothing else. */
data class ReaderUiState(
    val loading: Boolean = true,
    val missing: Boolean = false,
    val bookTitle: String = "",
    val path: String? = null,
    val audioPresent: Boolean = true,
    val chapters: List<ReaderChapter> = emptyList(),
    val renderedChapter: Int = 0,
)

/**
 * The reading surface's state owner: opens the book (through 004's
 * session flow, so a saved position picks the starting chapter),
 * renders **per-chapter** (the desktop pattern — the whole book is
 * never one scroll), and forwards outline jumps. Static by design;
 * transport + highlight are 007.
 */
class ReaderViewModel(
    private val opener: suspend () -> OpenedBook?,
    private val seeker: ChapterSeeker,
) : ViewModel() {
    private val _ui = MutableStateFlow(ReaderUiState())
    val ui: StateFlow<ReaderUiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch {
            val opened = opener()
            _ui.update {
                if (opened == null) {
                    it.copy(loading = false, missing = true)
                } else {
                    it.copy(
                        loading = false,
                        bookTitle = opened.title,
                        path = opened.path,
                        audioPresent = opened.audioPresent,
                        chapters = opened.chapters,
                        renderedChapter = opened.initialChapter,
                    )
                }
            }
        }
    }

    /** Outline selection: seek the session, switch the rendered chapter. */
    fun jumpToChapter(ordinal: Int) {
        if (ordinal !in _ui.value.chapters.indices) return
        seeker.seekToChapterStart(ordinal.toUInt())
        _ui.update { it.copy(renderedChapter = ordinal) }
    }

    companion object {
        fun factory(
            opener: suspend () -> OpenedBook?,
            seeker: ChapterSeeker,
        ): ViewModelProvider.Factory =
            viewModelFactory {
                initializer { ReaderViewModel(opener, seeker) }
            }
    }
}

/**
 * The production opener: 004's open flow (restore seeds the starting
 * chapter), flattened into plain UI data. The reader's kernel is
 * read-only — it is closed immediately; the *service's* session owns
 * playback and position persistence.
 */
suspend fun openBookForReading(
    context: Context,
    path: String,
    store: PositionStore,
    ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
): OpenedBook? =
    withContext(ioDispatcher) {
        runCatching {
            val session = BookSession.open(context, path, store)
            val initial =
                session.kernel
                    .snapshot()
                    .para
                    ?.chapter
                    ?.toInt() ?: 0
            val opened =
                OpenedBook(
                    title = session.book.title,
                    audioPresent = session.book.audioPresent,
                    path = path,
                    chapters =
                        session.book.chapters.map { chapter ->
                            ReaderChapter(
                                title = chapter.title,
                                paragraphs = chapter.paragraphs.map { it.text },
                            )
                        },
                    initialChapter = initial,
                )
            session.kernel.close()
            opened
        }.getOrNull()
    }

/** Production [ChapterSeeker]: the service's SEEK command over the controller. */
class ServiceChapterSeeker(
    private val controller: MediaController,
) : ChapterSeeker {
    override fun seekToChapterStart(chapter: UInt) {
        controller.sendCustomCommand(
            SessionCommands.SEEK_PARAGRAPH,
            Bundle().apply {
                putLong(SessionCommands.EXTRA_CHAPTER, chapter.toLong())
                putLong(SessionCommands.EXTRA_INDEX, 0L)
            },
        )
    }
}
