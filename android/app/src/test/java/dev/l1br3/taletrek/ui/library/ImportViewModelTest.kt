package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.service.SynthJobRequest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * The convert gate over fakes — the JVM half of the split (ContentResolver,
 * FFI voice cache, and startForegroundService all stay behind seams).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ImportViewModelTest {
    private lateinit var copied: File
    private val started = mutableListOf<SynthJobRequest>()
    private val deleted = mutableListOf<String>()
    private var voiceCached = false
    private var copyFails = false

    @Before
    fun setUp() {
        copied = File.createTempFile("source", ".txt").apply { writeText("chapter one\n\nalpha") }
        started.clear()
        deleted.clear()
        voiceCached = false
        copyFails = false
    }

    private fun vm(dispatcher: CoroutineDispatcher) =
        ImportViewModel(
            io = dispatcher,
            copySource = {
                if (copyFails) error("no stream") else copied.absolutePath to "source.txt"
            },
            hasCachedVoice = { voiceCached },
            selectedVoice = { null },
            startJob = { started += it },
            deleteSource = { deleted += it },
            dirs =
                ImportViewModel.ImportDirs(
                    voiceCacheDir = "/files/voices",
                    espeakDir = "/files/espeak",
                    booksDir = "/files/books",
                ),
        )

    @Test
    fun pickShowsTheGateWithVoiceContextAndEstimate() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            val gate = vm.ui.value
            assertTrue(gate is ImportUiState.Gate)
            gate as ImportUiState.Gate
            assertEquals(copied.absolutePath, gate.sourcePath)
            assertEquals("source.txt", gate.hint)
            assertEquals("source.txt", gate.fileName)
            assertFalse(gate.hasVoice)
            assertTrue(gate.estimatedMinutes >= 1)
        }

    @Test
    fun listenSubmitsAFullJobAndDropsTheGate() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            vm.chooseListen()
            val request = started.single()
            assertEquals(copied.absolutePath, request.sourcePath)
            assertEquals("source.txt", request.hint)
            assertFalse(request.textOnly)
            assertEquals(2, request.jobs)
            assertEquals("taletrek-android", request.generatorApp)
            assertEquals("/files/books", request.booksDir)
            assertEquals(ImportUiState.Idle, vm.ui.value)
            assertTrue("source lives until the job ends", deleted.isEmpty())
        }

    @Test
    fun textOnlySubmitsATextJob() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            vm.chooseTextOnly()
            assertTrue(started.single().textOnly)
        }

    @Test
    fun gateCancelDeletesTheCopy() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            vm.cancelGate()
            assertEquals(listOf(copied.absolutePath), deleted)
            assertEquals(ImportUiState.Idle, vm.ui.value)
        }

    @Test
    fun jobTerminalDeletesTheCopy() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            vm.chooseListen()
            assertTrue(deleted.isEmpty())
            vm.onJobTerminal()
            assertEquals(listOf(copied.absolutePath), deleted)
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
            vm.dismissError()
            assertEquals(ImportUiState.Idle, vm.ui.value)
        }

    @Test
    fun secondPickWhileGatedIsIgnored() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
            vm.onSourcePicked("content://other")
            advanceUntilIdle()
            val gate = vm.ui.value as ImportUiState.Gate
            assertEquals(copied.absolutePath, gate.sourcePath)
        }
}
