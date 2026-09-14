package dev.l1br3.taletrek.ui.library

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.data.PickedLane
import dev.l1br3.taletrek.data.SourceImport
import kotlinx.coroutines.launch

/**
 * The app's front door: every book the kernel can read out of
 * `books/`, manifest-driven, no database. Import via the system
 * picker, delete with confirmation, tap to read.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun LibraryScreen(
    viewModel: LibraryViewModel,
    importViewModel: ImportViewModel,
    onOpenBook: (BookShelf) -> Unit,
    onOpenVoices: () -> Unit,
    pendingImportUri: String?,
    pendingSourceUri: String?,
    onImportConsumed: () -> Unit,
    onSourceConsumed: () -> Unit,
) {
    val ui by viewModel.ui.collectAsState()
    val importUi by importViewModel.ui.collectAsState()
    val synthState by dev.l1br3.taletrek.service.SynthService.active
        .collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    val notifPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // One add action: pick anything, then route by display name — a
    // `.taletrek` is a bundle import, everything else converts (the
    // kernel's content sniffing arbitrates unknowns).
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pickDocument =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) {
                scope.launch {
                    val lane = SourceImport.laneOf(SourceImport.displayNameOf(context, uri))
                    if (lane == PickedLane.BUNDLE) {
                        viewModel.onImportPicked(uri.toString())
                    } else {
                        importViewModel.onSourcePicked(uri.toString())
                    }
                }
            }
        }

    // Import-from-open: a VIEW intent handed over by the activity.
    LaunchedEffect(pendingImportUri) {
        pendingImportUri?.let {
            viewModel.onImportPicked(it)
            onImportConsumed()
        }
    }

    // Convert-from-open: a source-document VIEW/OPEN_WITH intent.
    LaunchedEffect(pendingSourceUri) {
        pendingSourceUri?.let {
            importViewModel.onSourcePicked(it)
            onSourceConsumed()
        }
    }

    // A rejected import surfaces as a snackbar, never a dead screen.
    LaunchedEffect(ui.importError) {
        ui.importError?.let {
            snackbarHostState.showSnackbar("Couldn't import: $it")
            viewModel.dismissImportError()
        }
    }

    // Convert-flow failures surface the same way.
    LaunchedEffect(importUi) {
        val failed = importUi as? ImportUiState.Failed ?: return@LaunchedEffect
        snackbarHostState.showSnackbar("Couldn't import: ${failed.message}")
        importViewModel.dismissError()
    }

    // The job's terminal state spends the source copy and refreshes the
    // shelf (the bundle lands via filesDir/books — the scan's root).
    LaunchedEffect(synthState) {
        when (synthState) {
            is dev.l1br3.taletrek.service.SynthUiState.Done,
            is dev.l1br3.taletrek.service.SynthUiState.Failed,
            dev.l1br3.taletrek.service.SynthUiState.Cancelled,
            -> {
                importViewModel.onJobTerminal()
                viewModel.rescan()
            }
            else -> {}
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Library") },
                actions = {
                    IconButton(
                        onClick = onOpenVoices,
                        modifier =
                            Modifier.semantics { contentDescription = "Manage voices" },
                    ) { Icon(Icons.Default.Settings, contentDescription = null) }
                    IconButton(
                        onClick = { pickDocument.launch(arrayOf("*/*")) },
                        modifier =
                            Modifier.semantics { contentDescription = "Add a document or .taletrek bundle" },
                    ) { Icon(Icons.Default.Add, contentDescription = null) }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        when {
            ui.loading -> {
                Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Text("Scanning library…", style = MaterialTheme.typography.bodyLarge)
                }
            }
            ui.books.isEmpty() -> {
                Column(
                    modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        "No books yet.",
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Text(
                        "Add a document to convert it, or a .taletrek bundle to import it.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Button(onClick = { pickDocument.launch(arrayOf("*/*")) }) {
                        Text("Add a document")
                    }
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    synthState?.let { state ->
                        item { ConvertProgressRow(state) }
                    }
                    if (ui.skipped > 0) {
                        item {
                            Text(
                                "${ui.skipped} unreadable book${if (ui.skipped == 1) "" else "s"} skipped",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                        }
                    }
                    items(ui.books, key = { it.bookId }) { book ->
                        BookRow(
                            book = book,
                            onOpen = { onOpenBook(book) },
                            onRequestDelete = { viewModel.requestDelete(book) },
                        )
                    }
                }
            }
        }
    }

    ui.pendingDelete?.let { book ->
        AlertDialog(
            onDismissRequest = viewModel::cancelDelete,
            title = { Text("Delete book?") },
            text = { Text("\"${book.title}\" and its saved position will be removed from this device.") },
            confirmButton = {
                TextButton(onClick = viewModel::confirmDelete) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::cancelDelete) { Text("Cancel") }
            },
        )
    }
}

/** The in-flight convert job as a compact library row (no separate screen). */
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun ConvertProgressRow(state: dev.l1br3.taletrek.service.SynthUiState) {
    val (label, cancelable) =
        when (state) {
            is dev.l1br3.taletrek.service.SynthUiState.Preparing ->
                "Converting — reading document" to true
            is dev.l1br3.taletrek.service.SynthUiState.DownloadingVoice ->
                "Downloading ${state.done / (1024 * 1024)}/${state.total / (1024 * 1024)} MB" to true
            is dev.l1br3.taletrek.service.SynthUiState.Synthesizing ->
                "Synthesizing ${state.done}/${state.total}" to true
            dev.l1br3.taletrek.service.SynthUiState.Writing -> "Writing bundle…" to true
            is dev.l1br3.taletrek.service.SynthUiState.Done ->
                "Added \"${state.bookId}\" to the library" to false
            is dev.l1br3.taletrek.service.SynthUiState.Failed ->
                "Conversion failed: ${state.message}" to false
            dev.l1br3.taletrek.service.SynthUiState.Cancelled ->
                "Conversion cancelled" to false
            dev.l1br3.taletrek.service.SynthUiState.Idle -> return
        }
    ListItem(
        headlineContent = { Text(label, style = MaterialTheme.typography.bodyMedium) },
        trailingContent = {
            val context = androidx.compose.ui.platform.LocalContext.current
            if (cancelable) {
                TextButton(onClick = {
                    context.startService(
                        android.content
                            .Intent(
                                context,
                                dev.l1br3.taletrek.service.SynthService::class.java,
                            ).setAction(dev.l1br3.taletrek.service.SynthService.ACTION_CANCEL),
                    )
                }) { Text("Cancel") }
            }
        },
    )
    HorizontalDivider(modifier = Modifier.padding(start = 16.dp))
}

@OptIn(ExperimentalFoundationApi::class)
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun BookRow(
    book: BookShelf,
    onOpen: () -> Unit,
    onRequestDelete: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    ListItem(
        headlineContent = { Text(book.title, style = MaterialTheme.typography.titleMedium) },
        supportingContent = {
            Text(
                "${book.chapterCount} chapter${if (book.chapterCount == 1) "" else "s"}",
                style = MaterialTheme.typography.bodyMedium,
            )
        },
        trailingContent = {
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Default.MoreVert, contentDescription = "Book actions")
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Delete") },
                        leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null) },
                        onClick = {
                            menuOpen = false
                            onRequestDelete()
                        },
                    )
                }
            }
        },
        modifier =
            Modifier.combinedClickable(
                onClick = onOpen,
                onLongClick = onRequestDelete,
            ),
    )
    HorizontalDivider(modifier = Modifier.padding(start = 16.dp))
}
