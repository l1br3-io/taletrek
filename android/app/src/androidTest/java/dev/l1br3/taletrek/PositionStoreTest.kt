package dev.l1br3.taletrek

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.ffi.FfiPosition
import dev.l1br3.taletrek.ffi.positionStorageKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** The store's round-trip + corruption discipline, on device. */
@RunWith(AndroidJUnit4::class)
class PositionStoreTest {
    @Test
    fun saveThenLoadRoundTrips() =
        runBlocking {
            val (store, _, _) = freshStore("roundtrip")
            store.save("bk_one", FfiPosition(2u, 5u, 12.5))
            assertEquals(FfiPosition(2u, 5u, 12.5), store.load("bk_one"))
            // Another book's slot is independent.
            assertNull(store.load("bk_two"))
        }

    @Test
    fun aMissingKeyReadsAsAbsent() =
        runBlocking {
            val (store, _, _) = freshStore("missing")
            assertNull(store.load("bk_never_saved"))
        }

    @Test
    fun aCorruptEntryReadsAsAbsentNotACrash() =
        runBlocking {
            val (store, raw, _) = freshStore("corrupt")
            val base = positionStorageKey("bk_corrupt")
            // Corrupt shape 1: the chapter field stored as a String under
            // the typed key (a hostile or hand-edited file).
            raw.edit { prefs ->
                prefs[stringPreferencesKey("$base.chapter")] = "not-a-long"
                prefs[longPreferencesKey("$base.index")] = 1L
                prefs[doublePreferencesKey("$base.offset")] = 1.0
            }
            assertNull(store.load("bk_corrupt"))

            // Corrupt shape 2: a NaN offset reads absent (defensive).
            store.save("bk_bad", FfiPosition(9u, 9u, Double.NaN))
            assertNull(store.load("bk_bad"))
        }

    @Test
    fun clearRemovesTheSlot() =
        runBlocking {
            val (store, _, _) = freshStore("clear")
            store.save("bk_gone", FfiPosition(0u, 1u, 3.0))
            store.clear("bk_gone")
            assertNull(store.load("bk_gone"))
        }
}

/** A store over a throwaway file, plus the raw handle corruption tests need. */
private fun freshStore(
    name: String,
): Triple<PositionStore, androidx.datastore.core.DataStore<androidx.datastore.preferences.core.Preferences>, CoroutineScope> {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val file = context.preferencesDataStoreFile("test_positions_$name")
    file.delete()
    val raw = PreferenceDataStoreFactory.create(scope = scope) { file }
    return Triple(PositionStore(raw), raw, scope)
}
