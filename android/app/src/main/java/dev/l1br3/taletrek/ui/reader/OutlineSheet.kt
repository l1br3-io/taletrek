package dev.l1br3.taletrek.ui.reader

import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * The outline: all chapter titles in reading order. A bottom sheet,
 * not a drawer — the lighter primitive for a phone (one hand, one
 * gesture, no permanent chrome).
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
    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn {
            itemsIndexed(chapters) { index, chapter ->
                val isCurrent = index == current
                ListItem(
                    headlineContent = {
                        Text(
                            chapter.title,
                            style = MaterialTheme.typography.titleMedium,
                            color =
                                if (isCurrent) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.onSurface
                                },
                        )
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
