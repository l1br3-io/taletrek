package dev.l1br3.taletrek.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

// Placeholder schemes — the desktop-ux-refresh token parity lands with
// the reader screen (task 006).
private val LightScheme = lightColorScheme()

private val DarkScheme = darkColorScheme()

@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun TaletrekTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkScheme else LightScheme,
        content = content,
    )
}
