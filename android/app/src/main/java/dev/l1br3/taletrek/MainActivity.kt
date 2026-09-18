package dev.l1br3.taletrek

import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.l1br3.taletrek.data.BooksRepository
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.data.SourceImport
import dev.l1br3.taletrek.data.VoiceStore
import dev.l1br3.taletrek.service.PendingImportResume
import dev.l1br3.taletrek.service.PendingJobStore
import dev.l1br3.taletrek.service.SynthJobRequest
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.isRunningPhase
import dev.l1br3.taletrek.service.pipelineJobsForDevice
import dev.l1br3.taletrek.ui.library.ImportViewModel
import dev.l1br3.taletrek.ui.library.LibraryScreen
import dev.l1br3.taletrek.ui.library.LibraryViewModel
import dev.l1br3.taletrek.ui.reader.MediaControllerTransport
import dev.l1br3.taletrek.ui.reader.ReaderScreen
import dev.l1br3.taletrek.ui.reader.ReaderViewModel
import dev.l1br3.taletrek.ui.reader.openBookForReading
import dev.l1br3.taletrek.ui.theme.TaletrekTheme
import dev.l1br3.taletrek.ui.voices.VoiceScreen
import dev.l1br3.taletrek.ui.voices.VoiceViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File

class MainActivity : ComponentActivity() {
    private var navController: NavHostController? = null
    private var pendingImportUri by mutableStateOf<String?>(null)
    private var pendingSourceUri by mutableStateOf<String?>(null)

    private lateinit var libraryViewModel: LibraryViewModel
    private lateinit var importViewModel: ImportViewModel
    private lateinit var voiceViewModel: VoiceViewModel
    private lateinit var voiceStore: VoiceStore
    private lateinit var positionStore: PositionStore
    private lateinit var transport: MediaControllerTransport

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        transport = MediaControllerTransport(this)
        // One store instance for the process — DataStore allows exactly
        // one active handle per file (see PositionStore).
        positionStore = PositionStore.fromContext(this)
        val pendingStore = PendingJobStore(filesDir)
        libraryViewModel =
            ViewModelProvider(
                this,
                LibraryViewModel.factory(BooksRepository(this, positionStore)),
            )[LibraryViewModel::class.java]
        voiceStore = VoiceStore.fromContext(this)
        importViewModel =
            ViewModelProvider(
                this,
                ImportViewModel.factory(
                    io = kotlinx.coroutines.Dispatchers.IO,
                    copySource = { uri ->
                        val parsed = Uri.parse(uri)
                        val file = SourceImport.copyToCache(this, parsed)
                        file.absolutePath to SourceImport.displayNameOf(this, parsed)
                    },
                    isConverting = {
                        dev.l1br3.taletrek.service.SynthService.active.value
                            ?.isRunningPhase == true
                    },
                    selectedVoice = { voiceStore.selectedSnapshot() },
                    pipelineJobs = {
                        val am = getSystemService(ActivityManager::class.java)
                        val info = ActivityManager.MemoryInfo()
                        am.getMemoryInfo(info)
                        pipelineJobsForDevice(info.totalMem, am.isLowRamDevice)
                    },
                    startJob = { request: SynthJobRequest ->
                        startForegroundService(request.toIntent(this))
                    },
                    deleteSource = { path: String -> SourceImport.deleteQuietly(File(path)) },
                    pendingStore = pendingStore,
                    libraryBookPaths = { libraryBundlePaths() },
                    dirs =
                        ImportViewModel.ImportDirs(
                            voiceCacheDir = filesDir.resolve("voices").path,
                            espeakDir = filesDir.resolve("espeak-ng-data").path,
                            booksDir = filesDir.resolve("books").path,
                            segmentStoreDir = File(cacheDir, "taletrek/segments").path,
                        ),
                ),
            )[ImportViewModel::class.java]
        voiceViewModel =
            ViewModelProvider(
                this,
                VoiceViewModel.factory(
                    io = Dispatchers.IO,
                    voiceStore = voiceStore,
                    voiceCacheDir = { filesDir.resolve("voices").path },
                    espeakDir = { filesDir.resolve("espeak-ng-data").path },
                ),
            )[VoiceViewModel::class.java]
        maybeResumePendingImport(pendingStore)
        handleViewIntent(intent)
        setContent {
            TaletrekTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppNav(
                        libraryViewModel = libraryViewModel,
                        importViewModel = importViewModel,
                        voiceViewModel = voiceViewModel,
                        positionStore = positionStore,
                        transport = transport,
                        pendingImportUri = pendingImportUri,
                        pendingSourceUri = pendingSourceUri,
                        onImportConsumed = { pendingImportUri = null },
                        onSourceConsumed = { pendingSourceUri = null },
                        onNavControllerReady = { navController = it },
                        onResumeSynth = {
                            lifecycleScope.launch { resumePendingImport(pendingStore) }
                        },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleViewIntent(intent)
    }

    /**
     * Process death mid-fill recovery: once the shelf scan lands, a
     * resumable pending record re-submits its job (anchored at the
     * stored reading position). Re-entry is safe — the service's single
     * job slot rejects duplicates and the marker is spent on terminal.
     */
    private fun maybeResumePendingImport(pendingStore: PendingJobStore) {
        lifecycleScope.launch {
            resumePendingImport(pendingStore)
        }
    }

    /** One resume attempt over the scanned shelf (also the reader's
     *  stalled-load affordance action). */
    private suspend fun resumePendingImport(pendingStore: PendingJobStore) {
        val resume =
            PendingImportResume(
                store = pendingStore,
                loadPosition = { positionStore.load(it) },
                isConverting = { SynthService.active.value?.isRunningPhase == true },
                startJob = { request -> startForegroundService(request.toIntent(this@MainActivity)) },
            )
        resume.resumeWith(libraryViewModel.ui.first { !it.loading }.books)
    }

    /** The bundle paths currently on disk — the pending marker's shelf snapshot. */
    private fun libraryBundlePaths(): List<String> =
        filesDir
            .resolve("books")
            .listFiles { f -> f.isFile && f.name.endsWith(".taletrek") }
            ?.map { it.absolutePath }
            .orEmpty()

    /**
     * Import-from-open: a file manager hands us a `.taletrek` VIEW intent
     * (the library consumes it — copy-on-import, same path as the picker)
     * or a source document VIEW/OPEN_WITH intent (routed to the convert
     * gate). Mime decides the lane; mislabeled payloads fall to the source
     * lane where the kernel's content sniffing arbitrates.
     */
    private fun handleViewIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW && intent?.action != Intent.ACTION_OPEN_DOCUMENT) return
        val uri = intent.data ?: return
        when {
            dev.l1br3.taletrek.data.SourceImport
                .isSourceMime(intent.type) ->
                pendingSourceUri = uri.toString()
            else -> {
                pendingImportUri = uri.toString()
                navController?.popBackStack(ROUTE_LIBRARY, inclusive = false)
            }
        }
    }

    override fun onDestroy() {
        transport.release()
        super.onDestroy()
    }

    private companion object {
        const val ROUTE_LIBRARY = "library"
    }
}

@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun AppNav(
    libraryViewModel: LibraryViewModel,
    importViewModel: ImportViewModel,
    voiceViewModel: VoiceViewModel,
    positionStore: PositionStore,
    transport: MediaControllerTransport,
    pendingImportUri: String?,
    pendingSourceUri: String?,
    onImportConsumed: () -> Unit,
    onSourceConsumed: () -> Unit,
    onNavControllerReady: (NavHostController) -> Unit,
    onResumeSynth: () -> Unit,
) {
    val nav = rememberNavController()
    LaunchedEffect(nav) { onNavControllerReady(nav) }
    NavHost(navController = nav, startDestination = "library") {
        composable("library") {
            LibraryScreen(
                viewModel = libraryViewModel,
                importViewModel = importViewModel,
                onOpenBook = { book -> nav.navigate("reader/${book.bookId}") },
                onOpenVoices = { nav.navigate("voices") },
                pendingImportUri = pendingImportUri,
                pendingSourceUri = pendingSourceUri,
                onImportConsumed = onImportConsumed,
                onSourceConsumed = onSourceConsumed,
            )
        }
        composable("voices") {
            VoiceScreen(
                viewModel = voiceViewModel,
                onBack = { nav.popBackStack() },
            )
        }
        composable("reader/{bookId}") { entry ->
            val bookId = entry.arguments?.getString("bookId")
            val context = androidx.compose.ui.platform.LocalContext.current
            val readerViewModel: ReaderViewModel =
                viewModel(
                    factory =
                        ReaderViewModel.factory(
                            opener = {
                                val shelf = libraryViewModel.book(bookId ?: "")
                                if (shelf != null) openBookForReading(context, shelf.path, positionStore) else null
                            },
                            transport = transport,
                            isSynthJobActive = {
                                SynthService.active.value?.isRunningPhase == true
                            },
                            onResumeSynth = onResumeSynth,
                        ),
                )
            ReaderScreen(
                viewModel = readerViewModel,
                onBack = { nav.popBackStack() },
            )
        }
    }
}
