package dev.l1br3.taletrek

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Perf datapoints (task 008), emulator-labeled: sustained-synth wall time
 * at pool=2 vs pool=1 on the same document, and the whole-bytes parse RAM
 * delta on a multi-MB source. Rough by design — the hardware pass refines.
 */
@RunWith(AndroidJUnit4::class)
class PerfDatapointsTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    private fun shelf(name: String): File = File(files, "books/$name").apply { mkdirs() }

    private fun paragraphsDoc(count: Int): File {
        val dest = File(context.cacheDir, "paras-$count.txt")
        val paragraph = "This paragraph exists to give the parser and the synthesizer realistic work."
        dest.writeText(
            buildString {
                appendLine("chapter one")
                repeat(count) {
                    appendLine()
                    appendLine(paragraph)
                }
            },
        )
        return dest
    }

    private fun bigTxt(megabytes: Int): File {
        val dest = File(context.cacheDir, "big-$megabytes.txt")
        val paragraph = "This paragraph exists to give the parser and the synthesizer realistic work. ".repeat(4)
        // ~312 B/paragraph; `megabytes * 3` gives ~`megabytes` MB of source.
        dest.outputStream().use { out ->
            out.write("chapter one\n".toByteArray())
            repeat(megabytes * 3_400) {
                out.write("\n".toByteArray())
                out.write(paragraph.toByteArray())
            }
        }
        return dest
    }

    private fun request(
        src: File,
        books: File,
        jobs: Int,
        textOnly: Boolean,
    ) = SynthJobRequest(
        sourcePath = src.absolutePath,
        hint = src.name,
        textOnly = textOnly,
        voiceId = null,
        voiceCacheDir = File(files, "voices").path,
        espeakDir = File(files, "espeak-ng-data").path,
        booksDir = books.path,
        jobs = jobs,
        generatorApp = "taletrek-android",
    )

    private fun awaitTerminal(): SynthUiState =
        runBlocking {
            withTimeout(600_000) {
                SynthService.active.first {
                    it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                }!!
            }
        }

    @Test
    fun bigDocumentParseRamDelta() {
        val src = bigTxt(6)
        Runtime.getRuntime().gc()
        val infoBefore = android.os.Debug.MemoryInfo()
        android.os.Debug.getMemoryInfo(infoBefore)
        val pssBefore = infoBefore.totalPss

        val terminal =
            runBlocking {
                val before = SynthService.active.value
                context.startForegroundService(request(src, shelf("ram"), 2, textOnly = true).toIntent(context))
                withTimeout(120_000) { SynthService.active.first { it != before } }
                withTimeout(600_000) {
                    SynthService.active.first {
                        it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                    }!!
                }
            }
        assertTrue("big import failed: $terminal", terminal is SynthUiState.Done)
        val infoAfter = android.os.Debug.MemoryInfo()
        android.os.Debug.getMemoryInfo(infoAfter)
        // Rough by construction (the pipeline runs on a service thread and
        // GC timing varies) — the number is a floor for the parse+bundle
        // working set, labeled as such in the task Outcome.
        android.util.Log.i(
            "PerfDatapoints",
            "big-doc RAM: pss before=${infoBefore.totalPss}KB after=${infoAfter.totalPss}KB " +
                "delta=${infoAfter.totalPss - infoBefore.totalPss}KB src=${src.length() / (1024 * 1024)}MB",
        )
    }

    @Test
    fun poolOneVsTwoWallTimeOnTheSameDocument() {
        val silent =
            object : dev.l1br3.taletrek.ffi.FfiVoiceObserver {
                override fun onDownloadStep(
                    bytesDone: ULong,
                    bytesTotal: ULong,
                ) {}
            }
        dev.l1br3.taletrek.ffi
            .ffiEnsureEspeak(files.path, silent)
        dev.l1br3.taletrek.ffi
            .ffiResolveVoice(null, File(files, "voices").path, silent)

        // 60 paragraphs: ~40 s at pool=1 on the emulator datapoint — well
        // inside every timeout, still long enough to show the pool effect.
        val src = paragraphsDoc(60)
        val timings = mutableListOf<Pair<Int, Long>>()
        for (jobs in listOf(2, 1)) {
            val shelf = shelf("pool-$jobs")
            val t0 = System.nanoTime()
            runBlocking {
                val before = SynthService.active.value
                context.startForegroundService(request(src, shelf, jobs, textOnly = false).toIntent(context))
                withTimeout(120_000) { SynthService.active.first { it != before } }
            }
            val terminal = awaitTerminal()
            assertTrue("pool=$jobs run failed: $terminal", terminal is SynthUiState.Done)
            val ms = (System.nanoTime() - t0) / 1_000_000
            timings += jobs to ms
            android.util.Log.i(
                "PerfDatapoints",
                "pool=$jobs: ${ms}ms for 60 paragraphs = ${60_000L / ms.coerceAtLeast(1)} paras/min",
            )
        }
        assertTrue(timings.size == 2)
    }
}
