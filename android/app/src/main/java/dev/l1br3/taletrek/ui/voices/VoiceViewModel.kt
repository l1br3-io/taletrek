package dev.l1br3.taletrek.ui.voices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.l1br3.taletrek.ffi.FfiVoice
import dev.l1br3.taletrek.ffi.FfiVoiceObserver
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** One catalog row's render state. */
data class VoiceRow(
    val id: String,
    val name: String,
    val language: String,
    val quality: String,
    val sizeBytes: Long,
    val cached: Boolean,
    val selected: Boolean,
)

/** Download progress for one voice, as byte counts. */
data class DownloadState(
    val voiceId: String,
    val done: Long,
    val total: Long,
)

/** The catalog screen's render state. */
data class VoicesUiState(
    val loading: Boolean = true,
    val rows: List<VoiceRow> = emptyList(),
    val storageBytes: Long = 0,
    val espeakCached: Boolean = false,
    val downloading: DownloadState? = null,
    val error: String? = null,
)

/**
 * Voice management: list the curated catalog against the real cache,
 * download with live progress, delete, select. All FFI contact sits
 * behind seams for the JVM tests.
 *
 * Download "cancel" is a UI abandon: the FFI resolve call has no wire
 * cancel, so the fetch thread runs to completion in the background —
 * correct state either way, because the worker's cache write is atomic
 * (a cancelled-looking download never registers as cached unless it
 * actually finished) and a finished-but-abandoned download is just a
 * cached model.
 */
class VoiceViewModel(
    private val io: CoroutineDispatcher,
    private val catalog: () -> List<FfiVoice>,
    private val cachedIds: () -> List<String>,
    private val resolveVoice: suspend (id: String, progress: (Long, Long) -> Unit) -> Result<String>,
    private val deleteVoice: (id: String) -> Boolean,
    private val selectVoice: suspend (id: String) -> Unit,
    val selectedVoice: StateFlow<String?>,
    private val voiceCacheDir: () -> String,
    private val espeakDir: () -> String,
    private val storageBytes: () -> Long,
) : ViewModel() {
    private val _ui = MutableStateFlow(VoicesUiState())
    val ui: StateFlow<VoicesUiState> = _ui.asStateFlow()

    private var downloadJob: Job? = null

    init {
        viewModelScope.launch { refresh() }
        viewModelScope.launch {
            selectedVoice.collect { refresh() }
        }
    }

    /** Re-read catalog + cache state. */
    fun refresh() {
        _ui.value =
            _ui.value.copy(
                rows =
                    catalog().map { v ->
                        VoiceRow(
                            id = v.id,
                            name = v.name,
                            language = v.language,
                            quality = v.quality,
                            sizeBytes = v.sizeBytes.toLong(),
                            cached = v.id in cachedIds(),
                            selected = v.id == selectedVoice.value,
                        )
                    },
                storageBytes = storageBytes(),
                espeakCached = java.io.File(espeakDir(), "en_dict").isFile,
                loading = false,
            )
    }

    /** Download (or re-verify) one voice, with live byte progress. */
    fun download(id: String) {
        if (_ui.value.downloading != null) return // one download at a time
        _ui.value = _ui.value.copy(error = null, downloading = DownloadState(id, 0, 0))
        downloadJob =
            viewModelScope.launch(io) {
                resolveVoice(id) { done, total ->
                    _ui.value =
                        _ui.value.copy(downloading = DownloadState(id, done, total))
                }.fold(
                    onSuccess = { refresh() },
                    onFailure = { e ->
                        _ui.value =
                            _ui.value.copy(
                                error = e.message ?: e.javaClass.simpleName,
                            )
                    },
                )
                _ui.value = _ui.value.copy(downloading = null)
            }
    }

    /** Abandon the download UI (the fetch may still finish in background). */
    fun cancelDownload() {
        downloadJob?.cancel()
        downloadJob = null
        _ui.value = _ui.value.copy(downloading = null)
    }

    /**
     * Delete a cached model. Deleting the SELECTED voice is allowed — the
     * selection persists and the next full import re-downloads through
     * the worker's cache-or-download path.
     */
    fun delete(id: String) {
        viewModelScope.launch(io) {
            deleteVoice(id)
            refresh()
        }
    }

    fun select(id: String) {
        viewModelScope.launch {
            selectVoice(id)
            refresh()
        }
    }

    fun dismissError() {
        _ui.value = _ui.value.copy(error = null)
    }

    companion object {
        /** Factory over the real FFI seams. */
        fun factory(
            io: CoroutineDispatcher,
            voiceStore: dev.l1br3.taletrek.data.VoiceStore,
            voiceCacheDir: () -> String,
            espeakDir: () -> String,
        ): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    VoiceViewModel(
                        io = io,
                        catalog = {
                            dev.l1br3.taletrek.ffi
                                .voiceCatalog()
                        },
                        cachedIds = {
                            dev.l1br3.taletrek.ffi
                                .cachedVoiceIds(voiceCacheDir())
                        },
                        resolveVoice = { id, progress ->
                            runCatching {
                                dev.l1br3.taletrek.ffi.ffiResolveVoice(
                                    id,
                                    voiceCacheDir(),
                                    ProgressShim(progress),
                                )
                            }
                        },
                        deleteVoice = { id ->
                            dev.l1br3.taletrek.ffi
                                .deleteCachedVoice(voiceCacheDir(), id)
                        },
                        selectVoice = { voiceStore.setSelected(it) },
                        selectedVoice = voiceStore.selected,
                        voiceCacheDir = voiceCacheDir,
                        espeakDir = espeakDir,
                        storageBytes = {
                            dev.l1br3.taletrek.data.cachedVoiceBytes(
                                java.io.File(voiceCacheDir()),
                            )
                        },
                    ) as T
            }
    }
}

/** Kotlin-side (facing) observer forwarding to the seam's progress lambda. */
private class ProgressShim(
    private val onStep: (Long, Long) -> Unit,
) : FfiVoiceObserver {
    override fun onDownloadStep(
        bytesDone: ULong,
        bytesTotal: ULong,
    ) {
        onStep(bytesDone.toLong(), bytesTotal.toLong())
    }
}
