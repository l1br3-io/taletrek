package dev.l1br3.taletrek.ui.library

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.data.BooksRepo
import dev.l1br3.taletrek.data.ImportOutcome
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

/** The library screen's render state — Compose renders this, nothing else. */
data class LibraryUiState(
    val loading: Boolean = true,
    val books: List<BookShelf> = emptyList(),
    val skipped: Int = 0,
    val importError: String? = null,
    val pendingDelete: BookShelf? = null,
    val query: String = "",
    val exporting: BookShelf? = null,
    val exportError: String? = null,
) {
    /**
     * The shelf through the search filter — blank query = everything;
     * otherwise a case-insensitive substring match on title + author.
     * Ephemeral by design: derived from [books], never persisted.
     */
    val visible: List<BookShelf>
        get() {
            val q = query.trim()
            if (q.isEmpty()) return books
            return books.filter { book ->
                book.title.contains(q, ignoreCase = true) ||
                    book.author?.contains(q, ignoreCase = true) == true
            }
        }
}

/**
 * List-state owner: scans on start, drives import/delete through the
 * repo, and turns outcomes into UI state (a rejected import is a
 * surfaced error, a delete needs confirmation). No file or kernel
 * knowledge lives here — that's [BooksRepo]'s whole job.
 */
class LibraryViewModel(
    private val repo: BooksRepo,
) : ViewModel() {
    private val _ui = MutableStateFlow(LibraryUiState())
    val ui: StateFlow<LibraryUiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch { repo.refresh() }
        viewModelScope.launch {
            repo.state.collect { scanned ->
                _ui.update { it.copy(loading = false, books = scanned.books, skipped = scanned.skipped) }
            }
        }
    }

    /** Re-scan now — e.g. after a convert job dropped a bundle in `books/`. */
    fun rescan() {
        viewModelScope.launch { repo.refresh() }
    }

    /** A document was picked (SAF) or opened (VIEW intent) — import it. */
    fun onImportPicked(uri: String) {
        viewModelScope.launch {
            when (val outcome = repo.importFrom(uri)) {
                is ImportOutcome.Imported -> _ui.update { it.copy(importError = null) }
                is ImportOutcome.Rejected -> _ui.update { it.copy(importError = outcome.reason) }
            }
        }
    }

    fun dismissImportError() {
        _ui.update { it.copy(importError = null) }
    }

    /** The search text changed — the visible list re-derives live. */
    fun onQueryChange(query: String) {
        _ui.update { it.copy(query = query) }
    }

    /**
     * Prepare the merged whole-book audio (I/O-bound, seconds) and hand
     * the finished file to the screen for share/save. While preparing,
     * [LibraryUiState.exporting] names the book — further export calls
     * are dropped, so double-taps can't stack merges.
     */
    fun onExportAudio(
        book: BookShelf,
        onReady: (File) -> Unit,
    ) {
        if (_ui.value.exporting != null) return
        _ui.update { it.copy(exporting = book, exportError = null) }
        viewModelScope.launch {
            try {
                val file = repo.exportAudio(book)
                _ui.update { it.copy(exporting = null) }
                onReady(file)
            } catch (e: Exception) {
                onExportFailed(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    /** An export failure (merge or save-copy) — surfaces via the snackbar. */
    fun onExportFailed(message: String) {
        _ui.update { it.copy(exporting = null, exportError = message) }
    }

    fun dismissExportError() {
        _ui.update { it.copy(exportError = null) }
    }

    /**
     * A book by id, waiting for the first scan to land — the reader
     * route's opener suspends on this so a slow scan (or process
     * death) doesn't read as "missing".
     */
    suspend fun book(bookId: String): BookShelf? = ui.first { !it.loading }.books.find { it.bookId == bookId }

    fun requestDelete(book: BookShelf) {
        _ui.update { it.copy(pendingDelete = book) }
    }

    fun cancelDelete() {
        _ui.update { it.copy(pendingDelete = null) }
    }

    fun confirmDelete() {
        val book = _ui.value.pendingDelete ?: return
        _ui.update { it.copy(pendingDelete = null) }
        viewModelScope.launch { repo.delete(book) }
    }

    companion object {
        /** The activity-scoped factory (the repo is constructed once, in the activity). */
        fun factory(repo: BooksRepo): ViewModelProvider.Factory =
            viewModelFactory {
                initializer { LibraryViewModel(repo) }
            }
    }
}
