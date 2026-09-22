package dev.l1br3.taletrek

import android.net.Uri
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.data.BooksRepository
import dev.l1br3.taletrek.data.ExportFiles
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.ffi.openBook
import dev.l1br3.taletrek.ffi.readSegment
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * The export happy path, end to end on one device (FirstRunTest's
 * convert leg → the export flows): a tiny TXT through the REAL service,
 * then the repo's exportAudio → one `.opus` under cacheDir/exports that
 * ExoPlayer opens, whose duration is the sum of the segments' durations
 * (within the per-boundary tolerance the kernel suite uses). The share
 * leg stops at provider-URI construction — the system share UI is a
 * human checklist item, not a harness one.
 */
@RunWith(AndroidJUnit4::class)
class ExportTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val files get() = context.filesDir

    @Test
    fun convertThenExportProducesOneGaplessPlayableOpus() =
        runBlocking {
            val bundle = convertTinySource()
            val (repo, shelf) = repoWithBundleInBooks(bundle)
            assertTrue("the fixture book is audible", shelf.audioPresent)
            val book = openBook(bundle.absolutePath)

            // The merge: repo-owned temp under cacheDir/exports, never books/.
            val exported = withContext(Dispatchers.IO) { repo.exportAudio(shelf) }
            assertTrue(
                "export must live under cacheDir/exports: ${exported.absolutePath}",
                exported.absolutePath.startsWith(File(context.cacheDir, "exports").absolutePath),
            )
            assertTrue("merged opus is non-empty", exported.length() > 0)
            assertEquals(
                "<bookId>.opus under exports/",
                "${shelf.bookId}.opus",
                exported.name,
            )
            assertTrue(
                "books/ must not gain artifacts",
                File(files, "books").listFiles().orEmpty().all { it.name.endsWith(".taletrek") },
            )

            // ExoPlayer opens the merged file; its duration = Σ segment
            // durations (two boundaries → ≤ 100 ms tolerance).
            val mergedMs = exoDurationMs(exported.absolutePath)
            val segments =
                book.chapters
                    .flatMap { ch -> ch.paragraphs.map { it.segmentKey } }
                    .distinct()
            val segmentMs =
                segments.map { key -> exoDurationMs(segmentTempFile(bundle, key).absolutePath) }.sum()
            val toleranceMs = 100L * (segments.size - 1).coerceAtLeast(1)
            assertTrue(
                "merged ${mergedMs}ms vs Σ segments ${segmentMs}ms (tolerance ${toleranceMs}ms)",
                Math.abs(mergedMs - segmentMs) <= toleranceMs,
            )

            // The share leg: a grantable provider URI over the bundle as the
            // library holds it (filesDir/books — the provider's files-path).
            val libraryBundle = File(files, "books/exported.taletrek")
            val uri = ExportFiles.providerUri(context, libraryBundle).toString()
            assertTrue("provider URI: $uri", uri.startsWith("content://${ExportFiles.AUTHORITY}/"))
        }

    /** FirstRunTest's convert leg, unchanged: real service, real CDNs. */
    private fun convertTinySource(): File {
        val voices = freshDir("export/voices")
        val espeak = freshDir("export/espeak-ng-data")
        val books = freshDir("export/books")
        val source =
            File(context.cacheDir, "export-source.txt").apply {
                writeText("chapter one\n\nalpha beta gamma\n\ndelta epsilon\n\nzeta eta theta")
            }
        val request =
            SynthJobRequest(
                sourcePath = source.absolutePath,
                hint = source.name,
                voiceId = null,
                voiceCacheDir = voices.absolutePath,
                espeakDir = espeak.absolutePath,
                booksDir = books.absolutePath,
                storeDir = freshDir("export/segments").absolutePath,
                jobs = 2,
                generatorApp = "taletrek-android",
            )
        val terminal =
            runBlocking {
                val before = SynthService.active.value
                context.startForegroundService(request.toIntent(context))
                withTimeout(300_000) {
                    SynthService.active.first { it != before }
                }
                withTimeout(300_000) {
                    SynthService.active.first {
                        it is SynthUiState.Done || it is SynthUiState.Failed || it is SynthUiState.Cancelled
                    }!!
                }
            }
        assertTrue("convert failed: $terminal", terminal is SynthUiState.Done)
        return File((terminal as SynthUiState.Done).bundlePath).also { assertTrue(it.isFile) }
    }

    /** Isolated books/ + a repo over it, the produced bundle copied in. */
    private suspend fun repoWithBundleInBooks(bundle: File): Pair<BooksRepository, BookShelf> {
        val books =
            File(files, "books").apply {
                deleteRecursively()
                mkdirs()
            }
        bundle.copyTo(File(books, "exported.taletrek"), overwrite = true)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val file = context.preferencesDataStoreFile("test_positions_export_${System.nanoTime()}")
        val store =
            PositionStore(
                androidx.datastore.preferences.core.PreferenceDataStoreFactory
                    .create(scope = scope) { file },
            )
        val repo = BooksRepository(context, store)
        // GOTCHA: the repo never scans on construction (the ViewModel owns
        // the initial refresh) — without this call the state flow stays
        // empty and an awaiting test hangs forever.
        repo.refresh()
        val shelf =
            repo.state
                .first { it.books.isNotEmpty() }
                .books
                .single()
        return repo to shelf
    }

    /** One segment's bytes as a playable `.opus` temp file. */
    private fun segmentTempFile(
        bundle: File,
        key: String,
    ): File =
        File(context.cacheDir, "export-segment-$key.opus").apply {
            val bytes = readSegment(bundle.absolutePath, key)
            assertNotNull("segment $key present", bytes)
            writeBytes(requireNotNull(bytes))
        }

    /** Open `path` in ExoPlayer and read its duration (ms). */
    private fun exoDurationMs(path: String): Long {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val latch = CountDownLatch(1)
        val duration = AtomicLong(-1)
        val playerRef = AtomicReference<ExoPlayer>()
        instrumentation.runOnMainSync {
            val player = ExoPlayer.Builder(context).build()
            playerRef.set(player)
            player.setMediaItem(MediaItem.fromUri(Uri.fromFile(File(path))))
            player.addListener(
                object : Player.Listener {
                    override fun onPlaybackStateChanged(state: Int) {
                        if (state == Player.STATE_READY) {
                            duration.set(player.duration)
                            latch.countDown()
                        }
                    }

                    override fun onPlayerError(error: PlaybackException) {
                        latch.countDown()
                    }
                },
            )
            player.prepare()
        }
        assertTrue(
            "ExoPlayer could not open $path in time (or errored); duration=${duration.get()}",
            latch.await(30, TimeUnit.SECONDS),
        )
        val ms = duration.get()
        instrumentation.runOnMainSync { playerRef.get()?.release() }
        assertTrue("no duration for $path", ms > 0)
        return ms
    }

    private fun freshDir(name: String): File {
        val dir = File(files, name)
        dir.deleteRecursively()
        dir.mkdirs()
        return dir
    }
}
