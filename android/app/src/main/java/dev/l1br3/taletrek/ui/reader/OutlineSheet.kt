package dev.l1br3.taletrek.ui.reader

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** "Chapter n of N" — the outline's honest header context line. */
internal fun outlineHeader(
    current: Int,
    count: Int,
): String = "Chapter ${current + 1} of $count"

/**
 * One row's derived presentation: the ordinal every row carries, the
 * "Now reading" marker only the current row earns (a defensive
 * out-of-bounds [OutlineSheet]s `current` marks nothing — no index
 * equals it).
 */
internal data class OutlineRow(
    val ordinal: Int,
    val isCurrent: Boolean,
)

internal fun outlineRow(
    index: Int,
    current: Int,
): OutlineRow = OutlineRow(ordinal = index + 1, isCurrent = index == current)

/**
 * The outline: all chapter titles in reading order. A bottom sheet,
 * not a drawer — the lighter primitive for a phone (one hand, one
 * gesture, no permanent chrome). The locked reader-page design
 * (2026-09-15, ios-app spec § Reader page — parity is the product):
 * numbered rows with muted prefixes, the current chapter accented with
 * a trailing "Now reading" marker, a "Chapter n of N" header line, and
 * the sheet opening pre-scrolled to the current chapter.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun OutlineSheet(
    chapters: List<ReaderChapter>,
    current: Int,
    onJump: (Int) -> Unit,
    onDismiss: () -> Unit,
) {
    // ReaderScreen's `if (outlineOpen …)` gate means every open is a
    // fresh composition — once-per-composition is once-per-open.
    val listState = rememberLazyListState()
    LaunchedEffect(Unit) {
        // scrollToItem, no animation — cheap and decisive on long TOCs.
        // +1 = the header line occupies item 0 (list geometry, not
        // chapter arithmetic — the ChapterPane convention).
        listState.scrollToItem(current + 1)
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(state = listState) {
            item(key = "outline-header") {
                Text(
                    outlineHeader(current, chapters.size),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 16.dp, top = 4.dp, bottom = 8.dp),
                )
            }
            itemsIndexed(chapters) { index, chapter ->
                val row = outlineRow(index, current)
                ListItem(
                    headlineContent = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "${row.ordinal}.",
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(end = 8.dp),
                            )
                            Text(
                                chapter.title,
                                style = MaterialTheme.typography.titleMedium,
                                color =
                                    if (row.isCurrent) {
                                        MaterialTheme.colorScheme.primary
                                    } else {
                                        MaterialTheme.colorScheme.onSurface
                                    },
                            )
                        }
                    },
                    trailingContent =
                        if (row.isCurrent) {
                            {
                                Text(
                                    "Now reading",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                        } else {
                            null
                        },
                    modifier =
                        Modifier.clickable {
                            onJump(index)
                            onDismiss()
                        },
                )
            }
        }
    }
}
