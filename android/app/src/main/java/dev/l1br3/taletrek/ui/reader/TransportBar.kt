package dev.l1br3.taletrek.ui.reader

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * The transport bar: six forwards, zero decisions. Every button is a
 * one-line event out; enabled/playing state arrives derived from the
 * kernel's snapshot. Text-only books render it inert with the
 * explanatory hint (the spec's parity with desktop/web).
 */
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun TransportBar(
    state: TransportUiState,
    onPlayPause: () -> Unit,
    onPrevParagraph: () -> Unit,
    onNextParagraph: () -> Unit,
    onPrevChapter: () -> Unit,
    onNextChapter: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(
            modifier = modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TransportButton(
                    icon = SkipPreviousIcon,
                    label = "Previous chapter",
                    enabled = state.canPrevChapter,
                    onClick = onPrevChapter,
                )
                TransportButton(
                    icon = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                    label = "Previous paragraph",
                    enabled = state.canPrevParagraph,
                    onClick = onPrevParagraph,
                )
                TransportButton(
                    icon = if (state.playing) PauseIcon else Icons.Default.PlayArrow,
                    label = if (state.playing) "Pause" else "Play",
                    enabled = state.canPlayPause,
                    onClick = onPlayPause,
                )
                TransportButton(
                    icon = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    label = "Next paragraph",
                    enabled = state.canNextParagraph,
                    onClick = onNextParagraph,
                )
                TransportButton(
                    icon = SkipNextIcon,
                    label = "Next chapter",
                    enabled = state.canNextChapter,
                    onClick = onNextChapter,
                )
            }
            if (!state.canPlayPause) {
                Text(
                    "Text-only bundle — no audio to play.",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
private fun TransportButton(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    IconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.semantics { contentDescription = label },
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint =
                if (enabled) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.outline
                },
        )
    }
}
