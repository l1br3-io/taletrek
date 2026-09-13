package dev.l1br3.taletrek.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * The selected voice, Android backend: DataStore (Preferences) under one
 * string key — the platform-side selection store (the kernel stays
 * stateless about which voice is "current"; it just receives the id per
 * job). Mirrors the position-store pattern: one file, one active handle,
 * constructor-injected for tests.
 *
 * A synchronous snapshot ([selectedSnapshot]) backs non-suspend callers
 * (the import gate reads it at submit time); the [selected] flow keeps UI
 * collectors live.
 */
class VoiceStore(
    private val datastore: DataStore<Preferences>,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val key = stringPreferencesKey("voice.selected")

    private val _selected = MutableStateFlow<String?>(null)
    val selected: StateFlow<String?> = _selected.asStateFlow()

    init {
        scope.launch {
            _selected.value = datastore.data.first()[key]
            datastore.data.collect { prefs -> _selected.value = prefs[key] }
        }
    }

    /** The current selection for non-suspend callers (import submit). */
    fun selectedSnapshot(): String? = _selected.value

    /** Select `voiceId` (persisted; flow + snapshot follow). */
    suspend fun setSelected(voiceId: String) {
        datastore.edit { it[key] = voiceId }
    }

    companion object {
        // GOTCHA: DataStore allows exactly ONE active instance per file —
        // same as PositionStore; a process singleton guards the second
        // activity onCreate. Tests inject their own over throwaway files.
        @Volatile
        private var production: VoiceStore? = null

        /** The production instance over the app's voices file. */
        fun fromContext(context: Context): VoiceStore =
            production
                ?: synchronized(this) {
                    production
                        ?: VoiceStore(
                            PreferenceDataStoreFactory.create(
                                scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
                            ) {
                                context.preferencesDataStoreFile("voices")
                            },
                        ).also { production = it }
                }
    }
}

/** Bytes used by cached voice models — storage-summary input. */
fun cachedVoiceBytes(cacheDir: java.io.File): Long =
    cacheDir
        .takeIf { it.isDirectory }
        ?.listFiles()
        ?.filter { it.isFile }
        ?.sumOf { it.length() }
        ?: 0L
