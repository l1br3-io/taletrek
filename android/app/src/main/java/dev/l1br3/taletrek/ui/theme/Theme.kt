package dev.l1br3.taletrek.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// The desktop-ux-refresh token set, ported hex-for-hex (values, not
// CSS): dark "Phosphor ink" (warm near-black + amber phosphor) and
// light "Green screen paper" (sepia + phosphor green). Two faces by
// role, matching the desktop's rule: the story is serif, the machine
// (labels, meta, chrome) is monospace.

private val InkBg = Color(0xFF0E0D0B)
private val InkSurface = Color(0xFF16140F)
private val InkElevated = Color(0xFF211E16)
private val InkFg = Color(0xFFE8E4D8)
private val InkMuted = Color(0xFF8A8474)
private val InkLine = Color(0xFF2A2620)
private val Amber = Color(0xFFE8A838)
private val InkDanger = Color(0xFFC6553E)

// The web's --tt-accent-soft: accent breathed 14% (dark) / 12%
// (light) into the surface — the badge/highlight ground.
private val AmberSoft = Color(0xFF332814)
private val GreenSoft = Color(0xFFD4D4BE)

private val PaperBg = Color(0xFFF2EDE0)
private val PaperSurface = Color(0xFFE8E1D0)
private val PaperElevated = Color(0xFFDDD4BE)
private val PaperFg = Color(0xFF2A3328)
private val PaperMuted = Color(0xFF6A7560)
private val PaperLine = Color(0xFFC9C0A8)
private val PhosphorGreen = Color(0xFF4A7A3A)
private val PaperDanger = Color(0xFFA04030)

private val DarkScheme =
    darkColorScheme(
        primary = Amber,
        onPrimary = InkBg,
        primaryContainer = AmberSoft,
        onPrimaryContainer = Amber,
        secondary = InkMuted,
        onSecondary = InkBg,
        background = InkBg,
        onBackground = InkFg,
        surface = InkSurface,
        onSurface = InkFg,
        surfaceVariant = InkElevated,
        onSurfaceVariant = InkMuted,
        outline = InkLine,
        error = InkDanger,
        onError = PaperBg,
        // Flat colors, no tonal elevation — the hexes ARE the design.
        surfaceTint = Color.Transparent,
    )

private val LightScheme =
    lightColorScheme(
        primary = PhosphorGreen,
        onPrimary = PaperBg,
        primaryContainer = GreenSoft,
        onPrimaryContainer = PaperFg,
        secondary = PaperMuted,
        onSecondary = PaperBg,
        background = PaperBg,
        onBackground = PaperFg,
        surface = PaperSurface,
        onSurface = PaperFg,
        surfaceVariant = PaperElevated,
        onSurfaceVariant = PaperMuted,
        outline = PaperLine,
        error = PaperDanger,
        onError = PaperBg,
        surfaceTint = Color.Transparent,
    )

private val Story = FontFamily.Serif
private val Chrome = FontFamily.Monospace

private val TaletrekTypography =
    Typography(
        // Story face: book/chapter titles and the reading body.
        titleLarge =
            TextStyle(
                fontFamily = Story,
                fontWeight = FontWeight.Bold,
                fontSize = 22.sp,
                lineHeight = 28.sp,
            ),
        titleMedium =
            TextStyle(
                fontFamily = Story,
                fontWeight = FontWeight.SemiBold,
                fontSize = 17.sp,
                lineHeight = 24.sp,
            ),
        bodyLarge =
            TextStyle(
                fontFamily = Story,
                fontSize = 17.sp,
                lineHeight = 28.sp,
            ),
        // Machine face: meta, statuses, badges, the empty state.
        bodyMedium =
            TextStyle(
                fontFamily = Chrome,
                fontSize = 13.sp,
                lineHeight = 18.sp,
            ),
        labelMedium =
            TextStyle(
                fontFamily = Chrome,
                fontSize = 12.sp,
                lineHeight = 16.sp,
            ),
        labelSmall =
            TextStyle(
                fontFamily = Chrome,
                fontSize = 11.sp,
                lineHeight = 14.sp,
            ),
    )

@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun TaletrekTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkScheme else LightScheme,
        typography = TaletrekTypography,
        content = content,
    )
}
