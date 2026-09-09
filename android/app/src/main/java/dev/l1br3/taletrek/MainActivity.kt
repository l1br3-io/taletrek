package dev.l1br3.taletrek

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.l1br3.taletrek.data.BooksRepository
import dev.l1br3.taletrek.data.PositionStore
import dev.l1br3.taletrek.playback.PlaybackService
import dev.l1br3.taletrek.playback.SessionCommands
import dev.l1br3.taletrek.ui.library.LibraryScreen
import dev.l1br3.taletrek.ui.library.LibraryViewModel
import dev.l1br3.taletrek.ui.theme.TaletrekTheme
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

class MainActivity : ComponentActivity() {
    private var controllerFuture: java.util.concurrent.Future<MediaController>? = null
    private var navController: NavHostController? = null
    private var pendingImportUri by mutableStateOf<String?>(null)

    private lateinit var libraryViewModel: LibraryViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controllerFuture = mediaControllerFuture()
        libraryViewModel =
            ViewModelProvider(
                this,
                LibraryViewModel.factory(
                    BooksRepository(this, PositionStore.fromContext(this)),
                ),
            )[LibraryViewModel::class.java]
        handleViewIntent(intent)
        setContent {
            TaletrekTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppNav(
                        controller = controllerFuture!!.get(),
                        libraryViewModel = libraryViewModel,
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
            ReaderPlaceholder(
                controller = controller,
                libraryViewModel = libraryViewModel,
                bookId = entry.arguments?.getString("bookId"),
                onBack = { nav.popBackStack() },
            )
        }
    }
}

// DEBUG: the real reader screen lands in 006/007. Until then this
// placeholder keeps the Jog core drivable — it's the old debug
// transport, demoted from launch surface to a route behind the library.
@OptIn(ExperimentalMaterial3Api::class)
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun ReaderPlaceholder(
    controller: MediaController,
    libraryViewModel: LibraryViewModel,
    bookId: String?,
    onBack: () -> Unit,
) {
    val ui by libraryViewModel.ui.collectAsState()
    val book = ui.books.find { it.bookId == bookId }
    var status by remember { mutableStateOf("no book") }

    LaunchedEffect(book?.path) {
        if (book != null) {
            controller.sendCustomCommand(
                SessionCommands.OPEN_BOOK,
                Bundle().apply { putString(SessionCommands.EXTRA_PATH, book.path) },
            )
        }
    }

    // Poll the kernel's state (007 replaces polling with real observation).
    val mainExecutor = remember { java.util.concurrent.Executor(Handler(Looper.getMainLooper())::post) }
    LaunchedEffect(Unit) {
        while (currentCoroutineContext().isActive) {
            val future = controller.sendCustomCommand(SessionCommands.GET_STATE, Bundle.EMPTY)
            future.addListener(
                {
                    val extras = future.get().extras
                    val ch = extras.getLong(SessionCommands.STATE_CHAPTER)
                    val para =
                        if (ch < 0) {
                            ""
                        } else {
                            " ¶$ch:${extras.getLong(SessionCommands.STATE_INDEX)} @${extras.getDouble(SessionCommands.STATE_OFFSET)}s"
                        }
                    status =
                        "${extras.getString(SessionCommands.STATE_STATUS) ?: "?"}$para " +
                        "skipped=${extras.getLong(SessionCommands.STATE_SKIPPED)}"
                },
                mainExecutor,
            )
            delay(500)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(book?.title ?: "Reader") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to library")
                    }
                },
            )
        },
    ) { padding ->
        if (book == null) {
            Column(
                modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("This book isn't in the library anymore.", style = MaterialTheme.typography.bodyLarge)
                OutlinedButton(onClick = onBack) { Text("Back to library") }
            }
        } else {
            Column(
                modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(text = status, style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { controller.seekToPrevious() }) { Text("ch−") }
                    OutlinedButton(onClick = { controller.seekToNext() }) { Text("ch+") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { controller.sendCustomCommand(SessionCommands.PREV_PARAGRAPH, Bundle.EMPTY) },
                    ) { Text("¶−") }
                    OutlinedButton(
                        onClick = { controller.sendCustomCommand(SessionCommands.NEXT_PARAGRAPH, Bundle.EMPTY) },
                    ) { Text("¶+") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { controller.play() }) { Text("▶") }
                    OutlinedButton(onClick = { controller.pause() }) { Text("⏸") }
                }
            }
        }
    }
}
