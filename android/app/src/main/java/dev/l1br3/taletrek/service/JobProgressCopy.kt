package dev.l1br3.taletrek.service

/**
 * The shared job-progress derivations — one mapping over [SynthUiState],
 * three surfaces: the service notification, the library convert card,
 * and the reader's buffering line. Details and percents stay
 * byte-identical to what the notification and card rendered before the
 * extraction; terminals carry no shared copy (each surface owns its
 * outcome wording).
 */
data class JobProgressCopy(
    val detail: String?,
    val percent: Int?,
)

private const val MB = 1024L * 1024L

/** The running phases' detail + determinate percent (0–100). */
fun SynthUiState.jobProgressCopy(): JobProgressCopy =
    when (this) {
        is SynthUiState.Preparing ->
            JobProgressCopy(
                detail =
                    if (paragraphs != null && paragraphs > 0) {
                        "$chapters chapters · $paragraphs paragraphs"
                    } else {
                        "Reading…"
                    },
                percent = null,
            )
        is SynthUiState.DownloadingVoice ->
            JobProgressCopy(
                detail = if (total > 0) "${done / MB} of ${total / MB} MB" else "Downloading…",
                percent =
                    if (total > 0) {
                        ((done * 100) / total).toInt()
                    } else {
                        null
                    },
            )
        is SynthUiState.Synthesizing ->
            JobProgressCopy(
                detail = if (total > 0) "$done of $total paragraphs" else "Starting…",
                percent =
                    if (total > 0) {
                        ((done * 100) / total).toInt()
                    } else {
                        null
                    },
            )
        is SynthUiState.Filling ->
            JobProgressCopy(
                detail =
                    if (total > 0) {
                        "Listening available · $done of $total paragraphs"
                    } else {
                        "Listening available"
                    },
                percent =
                    if (total > 0) {
                        ((done * 100) / total).toInt()
                    } else {
                        null
                    },
            )
        SynthUiState.Writing -> JobProgressCopy(detail = "Writing bundle…", percent = null)
        else -> JobProgressCopy(detail = null, percent = null)
    }

/** The reader's buffering line for the live fill of the open book —
 *  the same counts, reader-flavored prefixes ("Downloading voice 12 of
 *  63 MB", "Preparing audio · 24 of 210 paragraphs"); null when the
 *  job carries nothing worth showing (terminals, idle). */
fun SynthUiState.fillLine(): String? =
    when (this) {
        is SynthUiState.Preparing ->
            if (paragraphs != null && paragraphs > 0) "$chapters chapters · $paragraphs paragraphs" else "Preparing audio…"
        is SynthUiState.DownloadingVoice ->
            if (total > 0) "Downloading voice ${done / MB} of ${total / MB} MB" else "Downloading voice…"
        is SynthUiState.Synthesizing ->
            if (total > 0) "Preparing audio · $done of $total paragraphs" else "Preparing audio…"
        is SynthUiState.Filling ->
            if (total > 0) "Preparing audio · $done of $total paragraphs" else "Preparing audio…"
        SynthUiState.Writing -> "Preparing audio…"
        else -> null
    }
