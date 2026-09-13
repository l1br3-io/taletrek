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

/** The source-import flow's render state (the gate dialog + error row). */
sealed interface ImportUiState {
    /** Nothing importing — no gate, no error. */
    data object Idle : ImportUiState

    /** A document was copied; the user chooses listen vs text-only.
     *  `estimatedMinutes` is a size-derived roughage, not a promise. */
    data class Gate(
        val sourcePath: String,
        val hint: String?,
        val fileName: String,
        val hasVoice: Boolean,
        val estimatedMinutes: Int,
    ) : ImportUiState

    /** The copy or start failed — surfaced, dismissible. */
    data class Failed(
        val message: String,
    ) : ImportUiState
}

/**
 * The convert gate's state machine — pure Kotlin over injected seams (the
 * JVM tests drive fakes; the real seams touch `ContentResolver`, the FFI
 * voice cache, and `startForegroundService`). The progress row is NOT here:
 * it renders [dev.l1br3.taletrek.service.SynthService.active] directly —
 * one process-wide job slot, one source of truth.
 *
 * The source copy's lifecycle is here: deleted on gate cancel and when the
 * job reaches any terminal state ([onJobTerminal]).
 */
class ImportViewModel(
    private val io: CoroutineDispatcher,
    private val copySource: suspend (uri: String) -> Pair<String, String?>,
    private val hasCachedVoice: () -> Boolean,
    private val startJob: (SynthJobRequest) -> Unit,
    private val deleteSource: (path: String) -> Unit,
    private val dirs: ImportDirs,
) : ViewModel() {
    private val _ui = MutableStateFlow<ImportUiState>(ImportUiState.Idle)
    val ui: StateFlow<ImportUiState> = _ui.asStateFlow()

    private var pendingSource: String? = null

    /** A source document was picked (SAF) or opened (VIEW intent). */
    fun onSourcePicked(uri: String) {
        if (_ui.value is ImportUiState.Gate) return // one gate at a time
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
            val size = java.io.File(path).length()
            _ui.value =
                ImportUiState.Gate(
                    sourcePath = path,
                    hint = hint,
                    fileName = hint?.substringAfterLast('/') ?: "Document",
                    hasVoice = hasCachedVoice(),
                    // ~3 KB/paragraph of source, ~1.5 s/paragraph of synth —
                    // a roughage, labelled "≈" in the UI.
                    estimatedMinutes = ((size / 3072L) * 15L / 1000L).toInt().coerceAtLeast(1),
                )
        }
    }

    /** Gate choice: full synth (voice resolves inside the job — cached or
     *  the curated default downloads with progress). */
    fun chooseListen() = submit(textOnly = false)

    /** Gate choice: stop after parse — a readable text-only bundle. */
    fun chooseTextOnly() = submit(textOnly = true)

    private fun submit(textOnly: Boolean) {
        val gate = _ui.value as? ImportUiState.Gate ?: return
        startJob(
            SynthJobRequest(
                sourcePath = gate.sourcePath,
                hint = gate.hint,
                textOnly = textOnly,
                voiceId = null,
                voiceCacheDir = dirs.voiceCacheDir,
                espeakDir = dirs.espeakDir,
                booksDir = dirs.booksDir,
                jobs = 2,
                generatorApp = "taletrek-android",
            ),
        )
        _ui.value = ImportUiState.Idle
    }

    /** Gate dismissed — drop the copied source. */
    fun cancelGate() {
        deletePending()
        _ui.value = ImportUiState.Idle
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
        /** The activity-scoped factory over the real seams. */
        fun factory(
            io: CoroutineDispatcher,
            copySource: suspend (uri: String) -> Pair<String, String?>,
            hasCachedVoice: () -> Boolean,
            startJob: (SynthJobRequest) -> Unit,
            deleteSource: (path: String) -> Unit,
            dirs: ImportDirs,
        ): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    ImportViewModel(io, copySource, hasCachedVoice, startJob, deleteSource, dirs)
                        as T
            }
    }
}
