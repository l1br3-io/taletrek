package dev.l1br3.taletrek

import android.content.ComponentName
import android.content.Intent
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
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.l1br3.taletrek.data.BooksRepository
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.playback.PlaybackService
import dev.l1br3.taletrek.ui.library.LibraryScreen
import dev.l1br3.taletrek.ui.library.LibraryViewModel
import dev.l1br3.taletrek.ui.reader.ReaderScreen
import dev.l1br3.taletrek.ui.reader.ReaderViewModel
import dev.l1br3.taletrek.ui.reader.ServiceChapterSeeker
import dev.l1br3.taletrek.ui.reader.openBookForReading
import dev.l1br3.taletrek.ui.theme.TaletrekTheme

class MainActivity : ComponentActivity() {
    private var controllerFuture: java.util.concurrent.Future<MediaController>? = null
    private var navController: NavHostController? = null
    private var pendingImportUri by mutableStateOf<String?>(null)

    private lateinit var libraryViewModel: LibraryViewModel
    private lateinit var positionStore: PositionStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controllerFuture = mediaControllerFuture()
        // One store instance for the process — DataStore allows exactly
        // one active handle per file (see PositionStore).
        positionStore = PositionStore.fromContext(this)
        libraryViewModel =
            ViewModelProvider(
                this,
                LibraryViewModel.factory(BooksRepository(this, positionStore)),
            )[LibraryViewModel::class.java]
        handleViewIntent(intent)
        setContent {
            TaletrekTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppNav(
                        controller = controllerFuture!!.get(),
                        libraryViewModel = libraryViewModel,
                        positionStore = positionStore,
                        pendingImportUri = pendingImportUri,
                        onImportConsumed = { pendingImportUri = null },
                        onNavControllerReady = { navController = it },
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
     * Import-from-open: a file manager hands us a `.taletrek` VIEW
     * intent; the library consumes it (copy-on-import, same path as the
     * picker) and we make sure the user lands on the library to see it.
     */
    private fun handleViewIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_VIEW && intent.data != null) {
            pendingImportUri = intent.data.toString()
            navController?.popBackStack(ROUTE_LIBRARY, inclusive = false)
        }
    }

    override fun onDestroy() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onDestroy()
    }

    private fun mediaControllerFuture() =
        MediaController
            .Builder(
                this,
                SessionToken(this, ComponentName(this, PlaybackService::class.java)),
            ).buildAsync()

    private companion object {
        const val ROUTE_LIBRARY = "library"
    }
}

@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun AppNav(
    controller: MediaController,
    libraryViewModel: LibraryViewModel,
    positionStore: PositionStore,
    pendingImportUri: String?,
    onImportConsumed: () -> Unit,
    onNavControllerReady: (NavHostController) -> Unit,
) {
    val nav = rememberNavController()
    LaunchedEffect(nav) { onNavControllerReady(nav) }
    NavHost(navController = nav, startDestination = "library") {
        composable("library") {
            LibraryScreen(
                viewModel = libraryViewModel,
                onOpenBook = { book -> nav.navigate("reader/${book.bookId}") },
                pendingImportUri = pendingImportUri,
                onImportConsumed = onImportConsumed,
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
                            seeker = ServiceChapterSeeker(controller),
                        ),
                )
            ReaderScreen(
                viewModel = readerViewModel,
                controller = controller,
                onBack = { nav.popBackStack() },
            )
        }
    }
}
