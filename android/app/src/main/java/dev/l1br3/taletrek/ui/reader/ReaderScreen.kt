package dev.l1br3.taletrek.ui.reader

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.media3.session.MediaController
import dev.l1br3.taletrek.playback.SessionCommands
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * The reading surface: one chapter at a time in a LazyColumn (the
 * desktop pattern — GOTCHA: rendering the whole book as one scroll is
 * the jank cliff LazyColumn-per-chapter exists to avoid; per-chapter
 * item counts stay bounded and the header is just another item).
 * Static by design: transport + highlight + click-to-seek are 007.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun ReaderScreen(
    viewModel: ReaderViewModel,
    controller: MediaController?,
    onBack: () -> Unit,
) {
    val ui by viewModel.ui.collectAsState()
    var outlineOpen by remember { mutableStateOf(false) }

    BackHandler(onBack = onBack)

    // The service opens the same bundle for playback (its own session;
    // positions stay its to persist — this side only reads).
    LaunchedEffect(ui.path) {
        val path = ui.path ?: return@LaunchedEffect
        controller?.sendCustomCommand(
            SessionCommands.OPEN_BOOK,
            Bundle().apply { putString(SessionCommands.EXTRA_PATH, path) },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(ui.bookTitle.ifEmpty { "Reader" }) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to library")
                    }
                },
                actions = {
                    IconButton(
                        onClick = { outlineOpen = true },
                        enabled = ui.chapters.isNotEmpty(),
                    ) { Icon(Icons.Default.Menu, contentDescription = "Chapters") }
                },
            )
        },
    ) { padding ->
        when {
            ui.loading -> {
                Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Text("Opening book…", style = MaterialTheme.typography.bodyLarge)
                }
            }
            ui.missing -> {
                Column(
                    modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("This book isn't in the library anymore.", style = MaterialTheme.typography.bodyLarge)
                    OutlinedButton(onClick = onBack) { Text("Back to library") }
                }
            }
            else -> {
                Column(modifier = Modifier.fillMaxSize().padding(padding)) {
                    ChapterPane(
                        chapter = ui.chapters[ui.renderedChapter],
                        modifier = Modifier.weight(1f),
                    )
                    if (controller != null) DebugTransport(controller)
                }
            }
        }
    }

    if (outlineOpen && ui.chapters.isNotEmpty()) {
        OutlineSheet(
            chapters = ui.chapters,
            current = ui.renderedChapter,
            onJump = viewModel::jumpToChapter,
            onDismiss = { outlineOpen = false },
        )
    }
}

/** The per-chapter text pane: header item + one item per paragraph. */
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun ChapterPane(
    chapter: ReaderChapter,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        contentPadding =
            androidx.compose.foundation.layout
                .PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item(key = "chapter-header") {
            Text(
                chapter.title,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        itemsIndexed(chapter.paragraphs) { _, paragraph ->
            Text(paragraph, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

// DEBUG: removed in 007, replaced by the transport bar — until then
// this keeps the Jog core drivable from inside the reader.
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun DebugTransport(controller: MediaController) {
    var status by remember { mutableStateOf("no book") }
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
    Column(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(status, style = MaterialTheme.typography.labelMedium, textAlign = TextAlign.Center)
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
