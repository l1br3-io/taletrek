package dev.l1br3.taletrek.ui.library

import dev.l1br3.taletrek.data.BookShelf
import dev.l1br3.taletrek.service.FillPhase
import dev.l1br3.taletrek.service.FillingBook
import dev.l1br3.taletrek.service.SynthUiState
import dev.l1br3.taletrek.service.isRunningPhase

/**
 * The library row's fill state — pure derivation from the monitor (the
 * rendering is dumb). A row is filling exactly when the live fill
 * targets it (progress detail from the job's state); a paused fill
 * (cancelled/failed, recovery material kept) is the recovery row;
 * everything else — desktop-made text-only imports included — keeps the
 * neutral row.
 */
data class FillingRowUi(
    val filling: Boolean,
    val detail: String?,
    val paused: Boolean = false,
)

fun fillingRowUi(
    book: BookShelf,
    filling: FillingBook?,
    active: SynthUiState?,
): FillingRowUi {
    if (book.audioPresent) return FillingRowUi(filling = false, detail = null)
    if (filling?.path != book.path) return FillingRowUi(filling = false, detail = null)
    return when (filling.phase) {
        FillPhase.Live ->
            FillingRowUi(
                filling = true,
                detail =
                    when (active) {
                        is SynthUiState.Synthesizing -> counts(active.done, active.total)
                        is SynthUiState.Filling -> counts(active.done, active.total)
                        else -> null
                    },
            )
        is FillPhase.Paused -> FillingRowUi(filling = false, detail = null, paused = true)
    }
}

private fun counts(
    done: Int,
    total: Int,
): String? = if (total > 0) "Preparing audio · $done of $total paragraphs" else null

/**
 * Whether the pinned convert card is visible — one row per book: once the
 * job's filling row is on the shelf, running progress lives on the row
 * and the card hides (the row's menu carries cancel). Before the row
 * exists (parse, voice download — first run) the card is the only
 * feedback. Terminal states keep the card until dismissed.
 */
fun convertCardVisible(
    state: SynthUiState?,
    fillingRowOnShelf: Boolean,
    terminalDismissed: Boolean,
): Boolean {
    if (state == null || state is SynthUiState.Idle) return false
    if (state.isRunningPhase) return !fillingRowOnShelf
    return !terminalDismissed
}
