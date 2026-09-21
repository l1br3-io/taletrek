package dev.l1br3.taletrek.service

import dev.l1br3.taletrek.ffi.FfiAnchor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The relaunch-resume record over a real properties file — JVM-direct. */
class PendingJobStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun store() = PendingJobStore(tmp.newFolder())

    private fun job(
        source: String = "/cache/import-source-1",
        anchor: FfiAnchor? = FfiAnchor(chapter = 1u, paragraph = 3u),
    ) = PendingJobStore.PendingJob(
        request =
            SynthJobRequest(
                sourcePath = source,
                hint = "novel.epub",
                voiceId = "vo_x",
                voiceCacheDir = "/files/voices",
                espeakDir = "/files/espeak",
                booksDir = "/files/books",
                storeDir = "/cache/taletrek/segments",
                jobs = 2,
                generatorApp = "taletrek-android",
                initialAnchor = anchor,
            ),
        preExistingBookPaths = listOf("/files/books/bk_old.taletrek"),
    )

    @Test
    fun saveThenLoadRoundTripsEveryField() {
        val store = store()
        store.save(job())
        assertEquals(job(), store.load())
    }

    @Test
    fun loadWithNoMarkerIsNull() {
        assertNull(store().load())
    }

    @Test
    fun clearRemovesTheMarker() {
        val store = store()
        store.save(job())
        store.clear()
        assertNull(store.load())
    }

    @Test
    fun saveOverwritesTheSingleSlot() {
        val store = store()
        store.save(job(source = "/cache/first"))
        store.save(job(source = "/cache/second"))
        assertEquals("/cache/second", store.load()?.request?.sourcePath)
    }

    @Test
    fun stampTerminalKeepsTheJobAndRecordsTheReason() {
        val store = store()
        store.save(job())
        store.stampTerminal(PendingTerminal.CANCELLED)
        val loaded = store.load()
        assertEquals(job(), loaded?.copy(terminalReason = null))
        assertEquals(PendingTerminal.CANCELLED, loaded?.terminalReason)
    }

    @Test
    fun stampTerminalOnAMissingMarkerIsANoOp() {
        val store = store()
        store.stampTerminal(PendingTerminal.FAILED)
        assertNull(store.load())
    }

    @Test
    fun aLegacyRecordWithoutTheTerminalKeyLoadsAsUnspent() {
        val dir = tmp.newFolder()
        val store = PendingJobStore(dir)
        store.save(job())
        // The installed base predates the key — strip it and reload.
        val file = dir.resolve("pending_synthjob.properties")
        val withoutTerminal =
            file
                .readLines()
                .filterNot { it.startsWith("terminal") }
                .joinToString("\n", postfix = "\n")
        file.writeText(withoutTerminal)
        assertEquals(null, store.load()?.terminalReason)
        assertEquals(job(), store.load())
    }
}
