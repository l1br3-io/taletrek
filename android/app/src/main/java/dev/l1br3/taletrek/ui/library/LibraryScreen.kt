package dev.l1br3.taletrek.ui.library

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.l1br3.taletrek.data.BookShelf

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
    onOpenBook: (BookShelf) -> Unit,
    pendingImportUri: String?,
    onImportConsumed: () -> Unit,
) {
    val ui by viewModel.ui.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    val notifPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    val pickDocument =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) viewModel.onImportPicked(uri.toString())
        }

    // Import-from-open: a VIEW intent handed over by the activity.
    LaunchedEffect(pendingImportUri) {
        pendingImportUri?.let {
            viewModel.onImportPicked(it)
            onImportConsumed()
        }
    }

    // A rejected import surfaces as a snackbar, never a dead screen.
    LaunchedEffect(ui.importError) {
        ui.importError?.let {
            snackbarHostState.showSnackbar("Couldn't import: $it")
            viewModel.dismissImportError()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Library") },
                actions = {
                    IconButton(
                        onClick = { pickDocument.launch(arrayOf("*/*")) },
                        modifier =
                            Modifier.semantics { contentDescription = "Import a .taletrek bundle" },
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
                Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Text(
                        "No books yet.\nImport a .taletrek bundle to start listening.",
                        style = MaterialTheme.typography.bodyLarge,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                AudioBadge(audioPresent = book.audioPresent)
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

/** The one fact a reader cares about at a glance: listen or read. */
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun AudioBadge(audioPresent: Boolean) {
    val (label, container, content) =
        if (audioPresent) {
            Triple("Audio", MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer)
        } else {
            Triple("Text", MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant)
        }
    Surface(shape = MaterialTheme.shapes.small, color = container) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = content,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}
