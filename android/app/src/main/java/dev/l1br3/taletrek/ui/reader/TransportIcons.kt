package dev.l1br3.taletrek.ui.reader

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

// The transport's missing three: Pause and the Skip pair are not in
// the (small) core icon set, and material-icons-extended is a heavy
// dependency for two triangles — these are the standard material path
// data, parsed straight into vectors.
private fun transportIcon(
    name: String,
    pathData: String,
): ImageVector =
    ImageVector
        .Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).addPath(
            pathData = addPathNodes(pathData),
            fill = SolidColor(Color.Black),
        ).build()

val PauseIcon = transportIcon("Filled.Pause", "M6 19h4V5H6v14zm8-14v14h4V5h-4z")

val SkipPreviousIcon = transportIcon("Filled.SkipPrevious", "M6 6h2v12H6zm3.5 6l8.5 6V6z")

val SkipNextIcon = transportIcon("Filled.SkipNext", "M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z")
