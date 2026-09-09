package dev.l1br3.taletrek.ui.reader

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.filterIsInstance

/**
 * The reading surface: one chapter at a time in a LazyColumn (the
 * desktop pattern — GOTCHA: rendering the whole book as one scroll is
 * the jank cliff per-chapter rendering exists to avoid). The sync
 * loop: the spoken paragraph highlights (identical frames — the
 * highlight fills a frame that's always there, so it never reflows),
 * playback auto-scrolls it into view unless the user is scrolling
 * (drag interactions defer; the next paragraph resumes), and tapping
 * a narrated paragraph seeks there — one event, kernel semantics.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun ReaderScreen(
    viewModel: ReaderViewModel,
    onBack: () -> Unit,
) {
    val ui by viewModel.ui.collectAsState()
    var outlineOpen by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val snackbarHostState = remember { SnackbarHostState() }

    BackHandler(onBack = onBack)

    // Only touch drags defer following — programmatic scrolls from
    // animateScrollToItem are NOT drag interactions, so auto-scroll
    // cannot pause itself.
    LaunchedEffect(listState) {
        listState.interactionSource.interactions
            .filterIsInstance<DragInteraction.Start>()
            .collect { viewModel.onUserScrolled() }
    }

    // The skip tolerance: each new failure batch says so, playback
    // keeps going (the web-reader behavior).
    LaunchedEffect(ui.skipped) {
        if (ui.skipped > 0u) {
            snackbarHostState.showSnackbar("Skipped ${ui.skipped} unreadable segment${if (ui.skipped == 1u) "" else "s"} — continuing")
        }
    }

    // Auto-scroll: on the active paragraph (any chapter switch rides
    // the same emission — the pane already renders the spoken chapter
    // while following).
    val active = ui.active
    LaunchedEffect(active, ui.follow, ui.renderedChapter) {
        if (ui.follow && active != null && active.chapter.toInt() == ui.renderedChapter) {
            // +1 = the chapter header occupies item 0 (list geometry,
            // not paragraph arithmetic).
            listState.animateScrollToItem(active.index.toInt() + 1)
        }
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
        snackbarHost = { SnackbarHost(snackbarHostState) },
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
                        activeIndex = if (active?.chapter?.toInt() == ui.renderedChapter) active.index.toInt() else null,
                        narrated = ui.audioPresent,
                        onParagraphTapped = viewModel::onParagraphTapped,
                        listState = listState,
                        modifier = Modifier.weight(1f),
                    )
                    TransportBar(
                        state = ui.transport,
                        onPlayPause = if (ui.transport.playing) viewModel::pause else viewModel::play,
                        onPrevParagraph = viewModel::prevParagraph,
                        onNextParagraph = viewModel::nextParagraph,
                        onPrevChapter = viewModel::prevChapter,
                        onNextChapter = viewModel::nextChapter,
                    )
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

/** The per-chapter text pane: header item + one framed item per paragraph. */
@OptIn(ExperimentalFoundationApi::class)
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun ChapterPane(
    chapter: ReaderChapter,
    activeIndex: Int?,
    narrated: Boolean,
    onParagraphTapped: (Int) -> Unit,
    listState: androidx.compose.foundation.lazy.LazyListState,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        item(key = "chapter-header") {
            Text(
                chapter.title,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(bottom = 12.dp),
            )
        }
        itemsIndexed(chapter.paragraphs) { index, paragraph ->
            val isActive = index == activeIndex
            // The identical frame: fill + padding exist whether active
            // or not, so the moving highlight never reflows the text.
            Box(
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(
                            when {
                                isActive -> MaterialTheme.colorScheme.primaryContainer
                                else -> androidx.compose.ui.graphics.Color.Transparent
                            },
                        ).padding(horizontal = 10.dp, vertical = 8.dp)
                        .then(
                            if (narrated) {
                                Modifier.clickable { onParagraphTapped(index) }
                            } else {
                                Modifier
                            },
                        ),
            ) {
                Text(
                    paragraph,
                    style = MaterialTheme.typography.bodyLarge,
                    color =
                        if (isActive) {
                            MaterialTheme.colorScheme.onPrimaryContainer
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                    modifier =
                        if (isActive) {
                            Modifier.semantics { contentDescription = "Spoken paragraph: $paragraph" }
                        } else {
                            Modifier
                        },
                )
            }
        }
    }
}
