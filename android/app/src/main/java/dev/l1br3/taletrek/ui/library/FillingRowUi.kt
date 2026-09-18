package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.service.SynthUiState
import dev.l1br3.taletrek.service.isRunningPhase

/**
 * The library row's filling state — pure derivation (the rendering is
 * dumb). A text-only row is "preparing audio" exactly when a live job
 * wrote it during this run (it appeared after the pending marker's
 * shelf snapshot); desktop-made text-only imports keep the neutral row.
 */
data class FillingRowUi(
    val filling: Boolean,
    val detail: String?,
)

fun fillingRowUi(
    book: BookShelf,
    active: SynthUiState?,
    preExistingPaths: Set<String>,
): FillingRowUi {
    if (book.audioPresent) return FillingRowUi(filling = false, detail = null)
    if (active == null || !active.isRunningPhase) return FillingRowUi(filling = false, detail = null)
    if (book.path in preExistingPaths) return FillingRowUi(filling = false, detail = null)
    val detail =
        when (active) {
            is SynthUiState.Synthesizing -> counts(active.done, active.total)
            is SynthUiState.Filling -> counts(active.done, active.total)
            else -> null
        }
    return FillingRowUi(filling = true, detail = detail)
}

private fun counts(
    done: Int,
    total: Int,
): String? = if (total > 0) "Preparing audio · $done of $total paragraphs" else null
