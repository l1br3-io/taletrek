package dev.l1br3.taletrek.ui.voices

import dev.l1br3.taletrek.ffi.FfiVoice
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The voice catalog view model over fakes — list/progress/error/selected
 * states without the `.so` (the real catalog + a real download round-trip
 * are instrumented).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class VoiceViewModelTest {
    private val mainDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(mainDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private val catalog =
        listOf(
            voice("en_US-hfc_female-medium", "HFC Female", "en_US", "medium", 63_000_000),
            voice("en_US-ryan-medium", "Ryan", "en_US", "medium", 62_000_000),
            voice("en_GB-alan-medium", "Alan", "en_GB", "medium", 61_000_000),
        )

    private var cached = mutableSetOf<String>()
    private val selectedFlow = MutableStateFlow<String?>(null)
    private val selections = mutableListOf<String>()
    private val deleted = mutableListOf<String>()
    private var resolveError: String? = null

    private fun voice(
        id: String,
        name: String,
        language: String,
        quality: String,
        size: Long,
    ) = FfiVoice(
        id = id,
        name = name,
        language = language,
        quality = quality,
        sizeBytes = size.toULong(),
    )

    private fun vm(dispatcher: CoroutineDispatcher) =
        VoiceViewModel(
            io = dispatcher,
            catalog = { catalog },
            cachedIds = { cached.toList() },
            resolveVoice = { id, progress ->
                val err = resolveError
                if (err != null) {
                    Result.failure(IllegalStateException(err))
                } else {
                    progress(10L, 100L)
                    cached += id
                    Result.success("/voices/$id.onnx")
                }
            },
            deleteVoice = {
                deleted += it
                cached.remove(it)
                true
            },
            selectVoice = {
                selections += it
                selectedFlow.value = it
            },
            selectedVoice = selectedFlow,
            voiceCacheDir = { "/files/voices" },
            espeakDir = { "/files/espeak-ng-data" },
            storageBytes = { cached.size * 60_000_000L },
        )

    @Test
    fun catalogRendersWithCachedAndSelectedBadges() =
        runTest(mainDispatcher) {
            cached += "en_US-ryan-medium"
            selectedFlow.value = "en_GB-alan-medium"
            val vm = vm(mainDispatcher)
            advanceUntilIdle()
            val rows = vm.ui.value.rows
            assertEquals(3, rows.size)
            assertEquals("HFC Female", rows[0].name)
            assertTrue(rows[0].sizeBytes > 0)
            assertTrue(rows.first { it.id == "en_US-ryan-medium" }.cached)
            assertFalse(rows.first { it.id == "en_US-hfc_female-medium" }.cached)
            assertTrue(rows.first { it.id == "en_GB-alan-medium" }.selected)
            assertEquals(60_000_000L, vm.ui.value.storageBytes)
        }

    @Test
    fun downloadTracksByteProgressThenRefreshesCache() =
        runTest(mainDispatcher) {
            val vm = vm(mainDispatcher)
            advanceUntilIdle()
            vm.download("en_US-hfc_female-medium")
            advanceUntilIdle()
            assertTrue(
                vm.ui.value.rows
                    .first { it.id == "en_US-hfc_female-medium" }
                    .cached,
            )
            assertNull(vm.ui.value.downloading)
            assertFalse(vm.ui.value.loading)
        }

    @Test
    fun downloadFailureSurfacesErrorAndNoCachedBadge() =
        runTest(mainDispatcher) {
            resolveError = "network down"
            val vm = vm(mainDispatcher)
            advanceUntilIdle()
            vm.download("en_US-hfc_female-medium")
            advanceUntilIdle()
            val error = vm.ui.value.error
            assertNotNull(error)
            assertTrue(error!!.contains("network down"))
            assertFalse(
                vm.ui.value.rows
                    .first { it.id == "en_US-hfc_female-medium" }
                    .cached,
            )
            vm.dismissError()
            assertNull(vm.ui.value.error)
        }

    @Test
    fun deletingTheSelectedVoicePersistsSelection() =
        runTest(mainDispatcher) {
            cached += "en_GB-alan-medium"
            selectedFlow.value = "en_GB-alan-medium"
            val vm = vm(mainDispatcher)
            advanceUntilIdle()
            vm.delete("en_GB-alan-medium")
            advanceUntilIdle()
            assertEquals(listOf("en_GB-alan-medium"), deleted)
            assertFalse(
                vm.ui.value.rows
                    .first { it.id == "en_GB-alan-medium" }
                    .cached,
            )
            assertTrue(
                "deleting the selected voice keeps the selection — the next full import re-downloads",
                vm.ui.value.rows
                    .first { it.id == "en_GB-alan-medium" }
                    .selected,
            )
            assertEquals("en_GB-alan-medium", selectedFlow.value)
        }

    @Test
    fun selectPersistsThroughTheStoreFlow() =
        runTest(mainDispatcher) {
            val vm = vm(mainDispatcher)
            advanceUntilIdle()
            vm.select("en_US-ryan-medium")
            advanceUntilIdle()
            assertEquals(listOf("en_US-ryan-medium"), selections)
            assertTrue(
                vm.ui.value.rows
                    .first { it.id == "en_US-ryan-medium" }
                    .selected,
            )
        }

    @Test
    fun oneDownloadAtATime() =
        runTest(mainDispatcher) {
            val vm = vm(mainDispatcher)
            advanceUntilIdle()
            vm.download("en_US-hfc_female-medium")
            vm.download("en_US-ryan-medium")
            advanceUntilIdle()
            // Only the first download ran; the second was refused.
            assertTrue(cached.contains("en_US-hfc_female-medium"))
            assertFalse(cached.contains("en_US-ryan-medium"))
        }
}
