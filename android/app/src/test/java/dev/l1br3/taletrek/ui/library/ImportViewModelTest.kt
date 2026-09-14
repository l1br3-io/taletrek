package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.service.SynthJobRequest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * The import flow over fakes — the JVM half of the split (ContentResolver
 * and startForegroundService stay behind seams). The gate is gone: a pick
 * submits the full job immediately; the only UI states are Idle | Failed.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ImportViewModelTest {
    private lateinit var copied: File
    private val started = mutableListOf<SynthJobRequest>()
    private val deleted = mutableListOf<String>()
    private var copyCalls = 0
    private var copyFails = false
    private var converting = false

    @Before
    fun setUp() {
        copied = File.createTempFile("source", ".txt").apply { writeText("chapter one\n\nalpha") }
        started.clear()
        deleted.clear()
        copyCalls = 0
        copyFails = false
        converting = false
    }

    private fun vm(dispatcher: CoroutineDispatcher) =
        ImportViewModel(
            io = dispatcher,
            copySource = {
                copyCalls++
                if (copyFails) error("no stream") else copied.absolutePath to "source.txt"
            },
            isConverting = { converting },
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
    fun pickSubmitsTheFullJobImmediately() =
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
            assertEquals(2, request.jobs)
            assertEquals("taletrek-android", request.generatorApp)
            assertEquals(ImportUiState.Idle, vm.ui.value)
            assertTrue("source lives until the job ends", deleted.isEmpty())
        }

    @Test
    fun jobTerminalDeletesTheCopy() =
        runTest(StandardTestDispatcher()) {
            val vm = vm(StandardTestDispatcher(testScheduler))
            vm.onSourcePicked("content://picked")
            advanceUntilIdle()
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
            assertTrue(started.isEmpty())
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
            val failed = vm.ui.value
            assertTrue(failed is ImportUiState.Failed)
            vm.dismissError()
            assertEquals(ImportUiState.Idle, vm.ui.value)
        }
}
