package dev.l1br3.taletrek.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import dev.l1br3.taletrek.ffi.FfiPosition
import dev.l1br3.taletrek.ffi.positionStorageKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first

/**
 * The position half of the platform contract, Android backend: DataStore
 * (Preferences) keyed by the kernel's own `positionStorageKey(bookId)`
 * string — one keying, no drift. The desktop stores the same three
 * fields under the same key prefix; a moved file and a re-voiced bundle
 * keep the place by construction (the book id rides through).
 *
 * Entries are field-per-key (`.chapter` / `.index` / `.offset`), the
 * desktop's shape: any missing or wrong-typed field reads the whole
 * position as absent — a position is one fact, never a half-position.
 * Orphaned positions (book deleted, 005 adds the UI) are accepted v1
 * behavior; cleanup rides the delete path.
 *
 * GOTCHA: the datastore comes in by constructor (tests inject their own
 * instance over a throwaway file — DataStore allows exactly ONE active
 * instance per file, so a test cannot open a second handle to corrupt
 * the production file; it wraps the instance it corrupted).
 */
class PositionStore(
    private val datastore: DataStore<Preferences>,
) {
    /** Persist `position` for `bookId` (typed field entries). */
    suspend fun save(
        bookId: String,
        position: FfiPosition,
    ) {
        val base = positionStorageKey(bookId)
        datastore.edit { prefs ->
            prefs[longPreferencesKey("$base.chapter")] = position.chapter.toLong()
            prefs[longPreferencesKey("$base.index")] = position.index.toLong()
            prefs[doublePreferencesKey("$base.offset")] = position.offset
        }
    }

    /** The saved position for `bookId`, or null when absent/corrupt. */
    suspend fun load(bookId: String): FfiPosition? {
        val base = positionStorageKey(bookId)
        val prefs = datastore.data.first()
        // Wrong-typed fields read null here (DataStore's typed get) — the
        // desktop's discard-the-whole-entry rule.
        val chapter = prefs[longPreferencesKey("$base.chapter")] ?: return null
        val index = prefs[longPreferencesKey("$base.index")] ?: return null
        val offset = prefs[doublePreferencesKey("$base.offset")] ?: return null
        if (chapter < 0 || index < 0 || !offset.isFinite()) return null
        return FfiPosition(chapter.toUInt(), index.toUInt(), offset)
    }

    /** Drop the saved position for `bookId` (005's delete path). */
    suspend fun clear(bookId: String) {
        val base = positionStorageKey(bookId)
        datastore.edit { prefs ->
            prefs.remove(longPreferencesKey("$base.chapter"))
            prefs.remove(longPreferencesKey("$base.index"))
            prefs.remove(doublePreferencesKey("$base.offset"))
        }
    }

    companion object {
        // GOTCHA: DataStore allows exactly ONE active instance per file —
        // a fresh create per fromContext() call would crash on the second
        // activity onCreate (rotation). The production instance is a
        // process singleton; tests inject their own over throwaway files.
        @Volatile
        private var production: PositionStore? = null

        /** The production instance over the app's positions file. */
        fun fromContext(context: Context): PositionStore =
            production
                ?: synchronized(this) {
                    production
                        ?: PositionStore(
                            PreferenceDataStoreFactory.create(
                                scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
                            ) {
                                context.preferencesDataStoreFile("taletrek_positions")
                            },
                        ).also { production = it }
                }
    }
}
