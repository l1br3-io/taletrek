package dev.l1br3.taletrek.ui.voices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * Voice management: the curated catalog against the real cache — download
 * with a determinate bar, delete (frees the app's biggest disk item),
 * select (persists; every import job receives the selection). Presentational:
 * every fact comes from [VoiceViewModel]'s state.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun VoiceScreen(
    viewModel: VoiceViewModel,
    onBack: () -> Unit,
) {
    val ui by viewModel.ui.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(ui.error) {
        ui.error?.let {
            snackbarHostState.showSnackbar("Voice download failed: $it")
            viewModel.dismissError()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Voices") },
                navigationIcon = {
                    IconButton(
                        onClick = onBack,
                        modifier = Modifier.semantics { contentDescription = "Back to library" },
                    ) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null) }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        if (ui.loading) {
            Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text("Loading voices…", style = MaterialTheme.typography.bodyLarge)
            }
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            item {
                Text(
                    buildString {
                        append("${ui.rows.count { it.cached }} of ${ui.rows.size} downloaded")
                        append(" · ${ui.storageBytes / (1024 * 1024)} MB used")
                        append(if (ui.espeakCached) " · phonemizer ready" else "")
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            items(ui.rows, key = { it.id }) { row ->
                VoiceRowCard(
                    row = row,
                    downloading = ui.downloading?.takeIf { it.voiceId == row.id },
                    onDownload = { viewModel.download(row.id) },
                    onCancelDownload = viewModel::cancelDownload,
                    onDelete = { viewModel.delete(row.id) },
                    onSelect = { viewModel.select(row.id) },
                )
                HorizontalDivider(modifier = Modifier.padding(start = 16.dp))
            }
        }
    }
}

@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun VoiceRowCard(
    row: VoiceRow,
    downloading: DownloadState?,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onDelete: () -> Unit,
    onSelect: () -> Unit,
) {
    ListItem(
        overlineContent = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Badge(row.language)
                Badge(row.quality)
                if (row.selected) Badge("Selected", primary = true)
                if (row.cached) Badge("Downloaded", primary = !row.selected)
            }
        },
        headlineContent = { Text(row.name, style = MaterialTheme.typography.titleMedium) },
        supportingContent = {
            Column {
                Text(
                    "~${row.sizeBytes / (1024 * 1024)} MB",
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (downloading != null) {
                    if (downloading.total > 0) {
                        LinearProgressIndicator(
                            progress = {
                                (downloading.done.toFloat() / downloading.total).coerceIn(0f, 1f)
                            },
                            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                        )
                        Text(
                            "${downloading.done / (1024 * 1024)} / ${downloading.total / (1024 * 1024)} MB",
                            style = MaterialTheme.typography.labelSmall,
                        )
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                    }
                }
            }
        },
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                when {
                    downloading != null ->
                        TextButton(onClick = onCancelDownload) { Text("Stop") }
                    row.cached && row.selected ->
                        TextButton(onClick = onDelete) { Text("Delete") }
                    row.cached ->
                        Row {
                            TextButton(onClick = onSelect) { Text("Select") }
                            TextButton(onClick = onDelete) { Text("Delete") }
                        }
                    else -> Button(onClick = onDownload) { Text("Download") }
                }
            }
        },
    )
}

@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun Badge(
    label: String,
    primary: Boolean = false,
) {
    val (container, content) =
        if (primary) {
            MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
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
