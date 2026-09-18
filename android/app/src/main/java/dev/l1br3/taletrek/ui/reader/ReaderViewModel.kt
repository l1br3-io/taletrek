package dev.l1br3.taletrek.ui.reader

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.l1br3.taletrek.data.BookSession
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.ffi.FfiParagraphPos
import dev.l1br3.taletrek.ffi.FfiPlayerStatus
import dev.l1br3.taletrek.playback.SessionState
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
    val bookId: String,
    val audioPresent: Boolean,
    val path: String,
    val chapters: List<ReaderChapter>,
    val initialChapter: Int,
    val initialPos: FfiParagraphPos? = null,
)

/**
 * The transport bar's enabled state, derived from the snapshot —
 * bounds facts about *where playback is*, never next/prev decisions.
 * `buffering`/`stalled` are the progressive fill's held-load states.
 */
data class TransportUiState(
    val canPlayPause: Boolean,
    val playing: Boolean,
    val canPrevParagraph: Boolean,
    val canNextParagraph: Boolean,
    val canPrevChapter: Boolean,
    val canNextChapter: Boolean,
    val buffering: Boolean = false,
    val stalled: Boolean = false,
)

/** The reader screen's render state — Compose renders this, nothing else. */
data class ReaderUiState(
    val loading: Boolean = true,
    val missing: Boolean = false,
    val bookTitle: String = "",
    val bookId: String? = null,
    val path: String? = null,
    val audioPresent: Boolean = true,
    val chapters: List<ReaderChapter> = emptyList(),
    val renderedChapter: Int = 0,
    val follow: Boolean = true,
    val status: FfiPlayerStatus = FfiPlayerStatus.IDLE,
    val active: FfiParagraphPos? = null,
    val skipped: UInt = 0u,
    val buffering: Boolean = false,
    val stalled: Boolean = false,
    val transport: TransportUiState =
        TransportUiState(
            canPlayPause = false,
            playing = false,
            canPrevParagraph = false,
            canNextParagraph = false,
            canPrevChapter = false,
            canNextChapter = false,
        ),
)

/**
 * The reading surface's state owner. Opens the book (004's session
 * flow picks the starting chapter from the saved position), renders
 * per-chapter, and runs the sync loop: session snapshots in, transport
 * forwards out. Sequencing never lives here — the kernel decides
 * everything; the ViewModel maps, filters (this book's snapshots
 * only), and applies the follow/defer scroll policy.
 */
class ReaderViewModel(
    private val opener: suspend () -> OpenedBook?,
    private val transport: ReaderTransport,
    private val isSynthJobActive: () -> Boolean = { false },
    private val onResumeSynth: () -> Unit = {},
) : ViewModel() {
    private val _ui = MutableStateFlow(ReaderUiState())
    val ui: StateFlow<ReaderUiState> = _ui.asStateFlow()

    private var lastPara: FfiParagraphPos? = null

    /** A filling book stays playable through its fill and after seal
     *  (sticky: armed at open when a job was live; the reads answer
     *  Ready from the sealed bundle from then on). */
    private var fillingSession = false

    init {
        viewModelScope.launch {
            val opened = opener()
            _ui.update { current ->
                if (opened == null) {
                    current.copy(loading = false, missing = true)
                } else {
                    current
                        .copy(
                            loading = false,
                            bookTitle = opened.title,
                            bookId = opened.bookId,
                            path = opened.path,
                            audioPresent = opened.audioPresent,
                            chapters = opened.chapters,
                            renderedChapter = opened.initialChapter,
                        ).withDerivedTransport()
                }
            }
            if (opened != null) {
                fillingSession = !opened.audioPresent && isSynthJobActive()
                if (fillingSession) {
                    opened.initialPos?.let {
                        transport.reanchor(it.chapter, it.index)
                    }
                }
                transport.openBook(opened.path)
            }
        }
        viewModelScope.launch {
            transport.states.collect { state ->
                if (state.bookId != null && state.bookId != _ui.value.bookId) return@collect
                _ui.update { current -> apply(current, state).withDerivedTransport() }
            }
        }
    }

    /** A snapshot for this book, mapped into render state. */
    private fun apply(
        current: ReaderUiState,
        state: SessionState,
    ): ReaderUiState {
        var next =
            current.copy(
                status = state.status,
                active = state.para,
                skipped = state.skipped,
                buffering = state.buffering,
                stalled = state.stalled,
            )
        // The follow policy (the task's locked rule, simpler than the
        // desktop's re-entry rule): a user scroll defers auto-scroll;
        // the NEXT paragraph re-arms it and the pane tracks the spoken
        // chapter again.
        if (state.para != null && state.para != lastPara) {
            lastPara = state.para
            next = next.copy(follow = true)
            val chapter = state.para.chapter.toInt()
            if (chapter in next.chapters.indices) {
                next = next.copy(renderedChapter = chapter)
            }
        }
        return next
    }

    /** Enabled-state derivation — bounds facts of the snapshot, nothing more. */
    private fun ReaderUiState.withDerivedTransport(): ReaderUiState {
        val para = active
        val audio = audioPresent || fillingSession
        val held = buffering || stalled
        val lastChapter = chapters.size - 1
        val atBookStart = para != null && para.chapter == 0u && para.index == 0u
        val atBookEnd =
            para != null &&
                para.chapter.toInt() == lastChapter &&
                para.index.toInt() == chapters[lastChapter].paragraphs.size - 1
        return copy(
            transport =
                TransportUiState(
                    canPlayPause = audio && !held,
                    playing = status == FfiPlayerStatus.PLAYING,
                    canPrevParagraph = audio && !held && para != null && !atBookStart,
                    canNextParagraph = audio && !held && para != null && !atBookEnd,
                    canPrevChapter = audio && !held && para != null && para.chapter > 0u,
                    canNextChapter = audio && !held && para != null && para.chapter.toInt() < lastChapter,
                    buffering = buffering,
                    stalled = stalled,
                ),
        )
    }

    /** The user scrolled by hand — defer auto-scroll until the next paragraph. */
    fun onUserScrolled() {
        _ui.update { it.copy(follow = false) }
    }

    /**
     * Click-to-seek: one SeekToParagraph forward — the kernel's own
     * semantics do the rest (idle starts playing there, paused
     * re-anchors paused, playing jumps). A filling book re-aims the
     * synth job here too (read ahead where the user actually is).
     */
    fun onParagraphTapped(index: Int) {
        transport.seekToParagraph(_ui.value.renderedChapter.toUInt(), index.toUInt())
        if (fillingSession) transport.reanchor(_ui.value.renderedChapter.toUInt(), index.toUInt())
        _ui.update { it.copy(follow = true) }
    }

    /** Outline selection: seek the session, switch the rendered chapter. */
    fun jumpToChapter(ordinal: Int) {
        if (ordinal !in _ui.value.chapters.indices) return
        transport.seekToParagraph(ordinal.toUInt(), 0u)
        if (fillingSession) transport.reanchor(ordinal.toUInt(), 0u)
        _ui.update { it.copy(renderedChapter = ordinal, follow = true) }
    }

    /** The stalled-load affordance: resubmit the synth job, retry the load. */
    fun resumeAudio() {
        onResumeSynth()
        transport.retryLoad()
    }

    fun play() = transport.play()

    fun pause() = transport.pause()

    fun nextParagraph() = transport.nextParagraph()

    fun prevParagraph() = transport.prevParagraph()

    fun nextChapter() = transport.nextChapter()

    fun prevChapter() = transport.prevChapter()

    companion object {
        fun factory(
            opener: suspend () -> OpenedBook?,
            transport: ReaderTransport,
            isSynthJobActive: () -> Boolean = { false },
            onResumeSynth: () -> Unit = {},
        ): ViewModelProvider.Factory =
            viewModelFactory {
                initializer { ReaderViewModel(opener, transport, isSynthJobActive, onResumeSynth) }
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
            val restored = session.kernel.snapshot().para
            val initial = restored?.chapter?.toInt() ?: 0
            val opened =
                OpenedBook(
                    title = session.book.title,
                    bookId = session.book.bookId,
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
                    initialPos = restored,
                )
            session.kernel.close()
            opened
        }.getOrNull()
    }
