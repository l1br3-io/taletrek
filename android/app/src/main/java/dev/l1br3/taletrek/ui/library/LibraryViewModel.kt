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

/** The library screen's render state — Compose renders this, nothing else. */
data class LibraryUiState(
    val loading: Boolean = true,
    val books: List<BookShelf> = emptyList(),
    val skipped: Int = 0,
    val importError: String? = null,
    val pendingDelete: BookShelf? = null,
)

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
