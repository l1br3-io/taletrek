package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.service.PendingJobStore
import dev.l1br3.taletrek.service.PendingTerminal
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The import flow over fakes — the JVM half of the split (ContentResolver
 * and startForegroundService stay behind seams). The gate is gone: a pick
 * submits the progressive job immediately; the only UI states are Idle |
 * Failed. The pending marker is the import flow's relaunch-resume record:
 * saved at submit, spent at terminal.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ImportViewModelTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var copied: File
    private lateinit var pendingStore: PendingJobStore
    private val started = mutableListOf<SynthJobRequest>()
    private val deleted = mutableListOf<String>()
    private var copyCalls = 0
    private var copyFails = false
    private var converting = false
    private var libraryBookPaths = listOf("/files/books/bk_old.taletrek")

    @Before
    fun setUp() {
        copied = File.createTempFile("source", ".txt").apply { writeText("chapter one\n\nalpha") }
        pendingStore = PendingJobStore(tmp.newFolder())
        started.clear()
        deleted.clear()
        copyCalls = 0
        copyFails = false
        converting = false
        libraryBookPaths = listOf("/files/books/bk_old.taletrek")
    }

    private fun vm(
        dispatcher: CoroutineDispatcher,
        pipelineJobs: () -> Int = { 2 },
    ): ImportViewModel =
        ImportViewModel(
            io = dispatcher,
            copySource = {
                copyCalls++
                if (copyFails) error("no stream") else copied.absolutePath to "source.txt"
            },
            isConverting = { converting },
            selectedVoice = { null },
            pipelineJobs = pipelineJobs,
            startJob = { started += it },
            deleteSource = { deleted += it },
            pendingStore = pendingStore,
            libraryBookPaths = { libraryBookPaths },
            dirs =
                ImportViewModel.ImportDirs(
                    voiceCacheDir = "/files/voices",
                    espeakDir = "/files/espeak",
                    booksDir = "/files/books",
                    segmentStoreDir = "/cache/taletrek/segments",
                ),
        )

    @Test
    fun pickSubmitsTheProgressiveJobImmediately() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()

            val request = started.single()
            assertEquals(copied.absolutePath, request.sourcePath)
            assertEquals("source.txt", request.hint)
            assertEquals(null, request.voiceId)
            assertEquals("/files/voices", request.voiceCacheDir)
            assertEquals("/files/espeak", request.espeakDir)
            assertEquals("/files/books", request.booksDir)
            assertEquals("/cache/taletrek/segments", request.storeDir)
            assertEquals(2, request.jobs)
            assertEquals("taletrek-android", request.generatorApp)
            assertNull(request.initialAnchor)
            assertEquals(ImportUiState.Idle, vm.ui.value)
            assertTrue("source lives until the job ends", deleted.isEmpty())
        }

    @Test
    fun pickSavesThePendingMarkerAgainstTheLibrarySnapshot() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()

            val pending = pendingStore.load()
            assertNotNull(pending)
            assertEquals(started.single(), pending?.request)
            assertEquals(libraryBookPaths, pending?.preExistingBookPaths)
        }

    @Test
    fun pickCarriesTheDevicePipelineJobs() =
        runTest(StandardTestDispatcher()) {
            val vm =
                vm(StandardTestDispatcher(testScheduler), pipelineJobs = { 1 })
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()

            assertEquals(1, started.single().jobs)
        }

    @Test
    fun jobTerminalDeletesTheCopyAndSpendsTheMarker() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            assertTrue(deleted.isEmpty())
            assertNotNull(pendingStore.load())
            vm.onJobTerminal(SynthUiState.Done("bk_new", "/files/books/bk_new.taletrek"))
            assertEquals(listOf(copied.absolutePath), deleted)
            assertNull(pendingStore.load())
        }

    @Test
    fun aCancelledTerminalKeepsTheMarkerStampedAndTheSource() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            vm.onJobTerminal(SynthUiState.Cancelled)
            assertTrue(deleted.isEmpty())
            assertEquals(PendingTerminal.CANCELLED, pendingStore.load()?.terminalReason)
            assertEquals(copied.absolutePath, pendingStore.load()?.request?.sourcePath)
        }

    @Test
    fun aFailedTerminalKeepsTheMarkerStampedAndTheSource() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            vm.onJobTerminal(SynthUiState.Failed("resolve", "offline"))
            assertTrue(deleted.isEmpty())
            assertEquals(PendingTerminal.FAILED, pendingStore.load()?.terminalReason)
        }

    @Test
    fun jobTerminalWithoutAPickSpendsTheMarkersSource() =
        runTest(StandardTestDispatcher()) {
            pendingStore.save(
                PendingJobStore.PendingJob(
                    request =
                        SynthJobRequest(
                            sourcePath = copied.absolutePath,
                            hint = null,
                            voiceId = null,
                            voiceCacheDir = "/files/voices",
                            espeakDir = "/files/espeak",
                            booksDir = "/files/books",
                            storeDir = "/cache/taletrek/segments",
                            jobs = 2,
                            generatorApp = "taletrek-android",
                        ),
                    preExistingBookPaths = emptyList(),
                ),
            )
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onJobTerminal(SynthUiState.Done("bk_new", "/files/books/bk_new.taletrek"))
            assertEquals(listOf(copied.absolutePath), deleted)
            assertNull(pendingStore.load())
        }

    @Test
    fun failedCopySurfacesTypedError() =
        runTest(StandardTestDispatcher()) {
            copyFails = true
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            val failed = vm.ui.value
            assertTrue(failed is ImportUiState.Failed)
            assertEquals("no stream", (failed as ImportUiState.Failed).message)
            assertTrue(started.isEmpty())
            assertNull(pendingStore.load())
            vm.dismissError()
            assertEquals(ImportUiState.Idle, vm.ui.value)
        }

    @Test
    fun pickWhileConvertingFailsBeforeCopyingOrStarting() =
        runTest(StandardTestDispatcher()) {
            converting = true
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            assertEquals("the guard fires before the copy", 0, copyCalls)
            assertTrue(started.isEmpty())
            assertTrue(deleted.isEmpty())
            assertNull(pendingStore.load())
            val failed = vm.ui.value
            assertTrue(failed is ImportUiState.Failed)
            vm.dismissError()
            assertEquals(ImportUiState.Idle, vm.ui.value)
        }
}
