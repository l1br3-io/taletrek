package dev.l1br3.taletrek.ui.library

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.l1br3.taletrek.service.SynthJobRequest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The source-import flow's render state (the error row; there is no gate). */
sealed interface ImportUiState {
    /** Nothing importing — no error. */
    data object Idle : ImportUiState

    /** The copy or start failed — surfaced, dismissible. */
    data class Failed(
        val message: String,
    ) : ImportUiState
}

/**
 * The import flow's state machine — pure Kotlin over injected seams (the
 * JVM tests drive fakes; the real seams touch `ContentResolver`, the
 * service's single-job slot, and `startForegroundService`). The progress
 * row is NOT here: it renders [dev.l1br3.taletrek.service.SynthService.active]
 * directly — one process-wide job slot, one source of truth.
 *
 * Zero decisions: a picked (or shared) source is copied and submitted as
 * the FULL job in one step — the voice (and, first run, espeak-ng-data)
 * resolves inside the job with progress. The source copy's lifecycle is
 * here: deleted when the job reaches any terminal state
 * ([onJobTerminal]).
 */
class ImportViewModel(
    private val io: CoroutineDispatcher,
    private val copySource: suspend (uri: String) -> Pair<String, String?>,
    private val isConverting: () -> Boolean,
    private val selectedVoice: () -> String?,
    private val startJob: (SynthJobRequest) -> Unit,
    private val deleteSource: (path: String) -> Unit,
    private val dirs: ImportDirs,
) : ViewModel() {
    private val _ui = MutableStateFlow<ImportUiState>(ImportUiState.Idle)
    val ui: StateFlow<ImportUiState> = _ui.asStateFlow()

    private var pendingSource: String? = null

    /** A source document was picked (SAF) or opened (VIEW intent). */
    fun onSourcePicked(uri: String) {
        // The guard fires BEFORE the copy: the service's single-job slot
        // would silently reject the submit, stranding an orphaned copy only
        // the NEXT terminal cleans up. Fail loudly instead.
        if (isConverting()) {
            _ui.value = ImportUiState.Failed(ALREADY_CONVERTING)
            return
        }
        _ui.value = ImportUiState.Idle
        viewModelScope.launch(io) {
            val (path, hint) =
                try {
                    copySource(uri)
                } catch (e: Exception) {
                    _ui.value =
                        ImportUiState.Failed(
                            e.message ?: e.javaClass.simpleName,
                        )
                    return@launch
                }
            pendingSource = path
            startJob(
                SynthJobRequest(
                    sourcePath = path,
                    hint = hint,
                    voiceId = selectedVoice(),
                    voiceCacheDir = dirs.voiceCacheDir,
                    espeakDir = dirs.espeakDir,
                    booksDir = dirs.booksDir,
                    jobs = 2,
                    generatorApp = "taletrek-android",
                ),
            )
            _ui.value = ImportUiState.Idle
        }
    }

    /** The job reached a terminal state — the source copy is spent. */
    fun onJobTerminal() = deletePending()

    fun dismissError() {
        if (_ui.value is ImportUiState.Failed) _ui.value = ImportUiState.Idle
    }

    private fun deletePending() {
        pendingSource?.let(deleteSource)
        pendingSource = null
    }

    /** Absolute host dirs the requests carry (explicit — kernel default
     *  caches resolve nothing on Android). */
    data class ImportDirs(
        val voiceCacheDir: String,
        val espeakDir: String,
        val booksDir: String,
    )

    companion object {
        const val ALREADY_CONVERTING = "Already converting a document"

        /** The activity-scoped factory over the real seams. */
        fun factory(
            io: CoroutineDispatcher,
            copySource: suspend (uri: String) -> Pair<String, String?>,
            isConverting: () -> Boolean,
            selectedVoice: () -> String?,
            startJob: (SynthJobRequest) -> Unit,
            deleteSource: (path: String) -> Unit,
            dirs: ImportDirs,
        ): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ImportViewModel(
                        io,
                        copySource,
                        isConverting,
                        selectedVoice,
                        startJob,
                        deleteSource,
                        dirs,
                    ) as T
            }
    }
}
