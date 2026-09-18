package dev.l1br3.taletrek.ui.library

import android.Manifest
import android.content.Intent
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import dev.l1br3.taletrek.data.ExportFiles
import dev.l1br3.taletrek.data.ExportKind
import dev.l1br3.taletrek.data.PickedLane
import dev.l1br3.taletrek.data.SourceImport
import dev.l1br3.taletrek.service.SynthService
import dev.l1br3.taletrek.service.SynthUiState
import dev.l1br3.taletrek.service.isRunningPhase
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException

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
    val synthState by SynthService.active.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var searchOpen by remember { mutableStateOf(false) }

    // Terminal convert feedback (Done/Failed/Cancelled) lingers as a
    // dismissible card; the flag resets when the next job starts.
    var terminalDismissed by remember { mutableStateOf(false) }
    LaunchedEffect(synthState) {
        if (synthState?.isRunningPhase == true) terminalDismissed = false
    }

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

    // Save flows: CreateDocument pickers registered once; the pending
    // target is remembered so the callback knows what to stream where.
    var saveBundleTarget by remember { mutableStateOf<BookShelf?>(null) }
    var saveAudioTarget by remember { mutableStateOf<Pair<BookShelf, File>?>(null) }

    val saveBundleLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(ExportKind.BUNDLE.mime)) { uri ->
            val book = saveBundleTarget
            saveBundleTarget = null
            if (uri != null && book != null) {
                scope.launch {
                    try {
                        context.contentResolver.openOutputStream(uri)?.use { out ->
                            File(book.path).inputStream().use { it.copyTo(out) }
                        } ?: throw IOException("could not open the chosen location")
                    } catch (e: Exception) {
                        viewModel.onExportFailed(e.message ?: e.javaClass.simpleName)
                    }
                }
            }
        }
    val saveAudioLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(ExportKind.AUDIO.mime)) { uri ->
            val target = saveAudioTarget
            saveAudioTarget = null
            if (uri != null && target != null) {
                val (_, temp) = target
                scope.launch {
                    try {
                        context.contentResolver.openOutputStream(uri)?.use { out ->
                            temp.inputStream().use { it.copyTo(out) }
                        } ?: throw IOException("could not open the chosen location")
                        temp.delete()
                    } catch (e: Exception) {
                        temp.delete()
                        viewModel.onExportFailed(e.message ?: e.javaClass.simpleName)
                    }
                }
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

    // Export failures (merge or save-copy) surface the same way.
    LaunchedEffect(ui.exportError) {
        ui.exportError?.let {
            snackbarHostState.showSnackbar("Couldn't export: $it")
            viewModel.dismissExportError()
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
            is SynthUiState.Done,
            is SynthUiState.Failed,
            SynthUiState.Cancelled,
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
                        onClick = {
                            // Collapsing the search restores the full shelf.
                            if (searchOpen) viewModel.onQueryChange("")
                            searchOpen = !searchOpen
                        },
                        modifier =
                            Modifier.semantics { contentDescription = "Search your books" },
                    ) {
                        Icon(
                            if (searchOpen) Icons.Default.Close else Icons.Default.Search,
                            contentDescription = null,
                        )
                    }
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
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            // The live search row — pinned under the bar, ephemeral state.
            if (searchOpen) {
                OutlinedTextField(
                    value = ui.query,
                    onValueChange = viewModel::onQueryChange,
                    singleLine = true,
                    placeholder = { Text("Search your books") },
                    trailingIcon = {
                        if (ui.query.isNotEmpty()) {
                            IconButton(onClick = { viewModel.onQueryChange("") }) {
                                Icon(Icons.Default.Close, contentDescription = "Clear search")
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            // The in-page convert surface — pinned above the body in
            // EVERY state (empty first-run library included), not just
            // the notification's shade. Running phases always show;
            // terminal ones stay until dismissed.
            val convertState = synthState
            if (convertState != null && convertState !is SynthUiState.Idle) {
                if (convertState.isRunningPhase || !terminalDismissed) {
                    ConvertProgressCard(
                        state = convertState,
                        onCancel = {
                            context.startService(
                                Intent(context, SynthService::class.java)
                                    .setAction(SynthService.ACTION_CANCEL),
                            )
                        },
                        onDismiss = { terminalDismissed = true },
                    )
                }
            }
            when {
                ui.loading -> {
                    Box(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("Scanning library…", style = MaterialTheme.typography.bodyLarge)
                    }
                }
                ui.books.isEmpty() -> {
                    Column(
                        modifier =
                            Modifier.weight(1f).fillMaxWidth().padding(24.dp),
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
                ui.visible.isEmpty() -> {
                    // A full shelf filtered down to nothing — distinct from
                    // the first-run state above.
                    Box(
                        modifier = Modifier.weight(1f).fillMaxWidth().padding(24.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "No books match \"${ui.query.trim()}\".",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                else -> {
                    LazyColumn(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
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
                        items(ui.visible, key = { it.bookId }) { book ->
                            BookRow(
                                book = book,
                                preparingAudio = ui.exporting == book,
                                onOpen = { onOpenBook(book) },
                                onRequestDelete = { viewModel.requestDelete(book) },
                                onShareBundle = {
                                    context.startActivity(
                                        ExportFiles.shareIntent(
                                            context,
                                            File(book.path),
                                            ExportKind.BUNDLE.mime,
                                            "Share \"${book.title}\"",
                                        ),
                                    )
                                },
                                onSaveBundle = {
                                    saveBundleTarget = book
                                    saveBundleLauncher.launch(
                                        ExportFiles.suggestedFileName(book.bookId, book.title, ExportKind.BUNDLE),
                                    )
                                },
                                onShareAudio = {
                                    viewModel.onExportAudio(book) { file ->
                                        context.startActivity(
                                            ExportFiles.shareIntent(
                                                context,
                                                file,
                                                ExportKind.AUDIO.mime,
                                                "Share \"${book.title}\" (audio)",
                                            ),
                                        )
                                    }
                                },
                                onSaveAudio = {
                                    viewModel.onExportAudio(book) { file ->
                                        saveAudioTarget = book to file
                                        saveAudioLauncher.launch(
                                            ExportFiles.suggestedFileName(book.bookId, book.title, ExportKind.AUDIO),
                                        )
                                    }
                                },
                            )
                        }
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

/**
 * The live convert job as a pinned status card — the page's own
 * processing feedback, mirroring the notification's phases and copy:
 * a determinate bar while the state carries counts (download bytes,
 * synthesized paragraphs), indeterminate otherwise, Cancel while
 * running, Dismiss once terminal.
 */
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun ConvertProgressCard(
    state: SynthUiState,
    onCancel: () -> Unit,
    onDismiss: () -> Unit,
) {
    val (title, detail) =
        when (state) {
            is SynthUiState.Preparing ->
                "Converting document" to
                    if (state.paragraphs != null && state.paragraphs > 0) {
                        "${state.chapters} chapters · ${state.paragraphs} paragraphs"
                    } else {
                        "Reading…"
                    }
            is SynthUiState.DownloadingVoice ->
                "Downloading voice" to
                    if (state.total > 0) {
                        "${state.done / (1024 * 1024)} of ${state.total / (1024 * 1024)} MB"
                    } else {
                        "Downloading…"
                    }
            is SynthUiState.Synthesizing ->
                "Synthesizing audio" to
                    if (state.total > 0) "${state.done} of ${state.total} paragraphs" else "Starting…"
            is SynthUiState.Filling ->
                "Preparing audio" to
                    if (state.total > 0) {
                        "Listening available · ${state.done} of ${state.total} paragraphs"
                    } else {
                        "Listening available"
                    }
            SynthUiState.Writing -> "Finishing" to "Writing bundle…"
            is SynthUiState.Done -> "Book ready" to "Added to your library"
            is SynthUiState.Failed -> "Conversion failed" to state.message
            SynthUiState.Cancelled -> "Conversion cancelled" to null
            SynthUiState.Idle -> return
        }
    val percent =
        when (state) {
            is SynthUiState.DownloadingVoice ->
                if (state.total > 0) ((state.done * 100) / state.total).toInt() else null
            is SynthUiState.Synthesizing ->
                if (state.total > 0) (state.done * 100) / state.total else null
            is SynthUiState.Filling ->
                if (state.total > 0) (state.done * 100) / state.total else null
            else -> null
        }
    ListItem(
        headlineContent = { Text(title, style = MaterialTheme.typography.titleSmall) },
        supportingContent = {
            Column {
                detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                if (state.isRunningPhase) {
                    if (percent != null) {
                        LinearProgressIndicator(
                            progress = { percent / 100f },
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        )
                    } else {
                        LinearProgressIndicator(
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        )
                    }
                }
            }
        },
        trailingContent = {
            if (state.isRunningPhase) {
                TextButton(onClick = onCancel) { Text("Cancel") }
            } else {
                TextButton(onClick = onDismiss) { Text("Dismiss") }
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
    preparingAudio: Boolean,
    onOpen: () -> Unit,
    onRequestDelete: () -> Unit,
    onShareBundle: () -> Unit,
    onSaveBundle: () -> Unit,
    onShareAudio: () -> Unit,
    onSaveAudio: () -> Unit,
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
                        text = { Text("Share bundle") },
                        onClick = {
                            menuOpen = false
                            onShareBundle()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Save bundle") },
                        onClick = {
                            menuOpen = false
                            onSaveBundle()
                        },
                    )
                    if (book.audioPresent) {
                        if (preparingAudio) {
                            // Transient merge state — visible but inert.
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        "Preparing audio…",
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                },
                                onClick = {},
                                enabled = false,
                            )
                        } else {
                            DropdownMenuItem(
                                text = { Text("Share audio") },
                                onClick = {
                                    menuOpen = false
                                    onShareAudio()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Save audio") },
                                onClick = {
                                    menuOpen = false
                                    onSaveAudio()
                                },
                            )
                        }
                    }
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
