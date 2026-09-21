package dev.l1br3.taletrek.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The shared job-progress derivation — one mapping, three surfaces
 * (notification, convert card, reader buffering line). The detail and
 * percent must stay byte-identical to what the notification and card
 * rendered before the extraction; the reader line composes its own
 * prefixes on the same counts.
 */
class JobProgressCopyTest {
    @Test
    fun downloadingVoiceCarriesMegabytesAndPercent() {
        val copy = SynthUiState.DownloadingVoice(done = 12L * 1024 * 1024, total = 63L * 1024 * 1024).jobProgressCopy()
        assertEquals("12 of 63 MB", copy.detail)
        assertEquals(19, copy.percent)
    }

    @Test
    fun unknownTotalDownloadsAreIndeterminate() {
        val copy = SynthUiState.DownloadingVoice(done = 0, total = 0).jobProgressCopy()
        assertEquals("Downloading…", copy.detail)
        assertNull(copy.percent)
    }

    @Test
    fun preparingCarriesShapeCountsWhenKnown() {
        val known = SynthUiState.Preparing(chapters = 3, paragraphs = 210).jobProgressCopy()
        assertEquals("3 chapters · 210 paragraphs", known.detail)
        assertNull(known.percent)
        assertEquals("Reading…", SynthUiState.Preparing(null, null).jobProgressCopy().detail)
    }

    @Test
    fun synthesizingAndFillingCarryParagraphCounts() {
        val synth = SynthUiState.Synthesizing(done = 24, total = 210).jobProgressCopy()
        assertEquals("24 of 210 paragraphs", synth.detail)
        assertEquals(11, synth.percent)
        val filling = SynthUiState.Filling(done = 24, total = 210).jobProgressCopy()
        assertEquals("Listening available · 24 of 210 paragraphs", filling.detail)
        assertEquals(11, filling.percent)
        assertEquals("Starting…", SynthUiState.Synthesizing(0, 0).jobProgressCopy().detail)
        assertEquals("Listening available", SynthUiState.Filling(0, 0).jobProgressCopy().detail)
    }

    @Test
    fun terminalsCarryNoSharedCopy() {
        assertNull(SynthUiState.Done("bk", "/books/bk.taletrek").jobProgressCopy().detail)
        assertNull(SynthUiState.Failed("resolve", "down").jobProgressCopy().detail)
        assertNull(SynthUiState.Cancelled.jobProgressCopy().detail)
    }

    @Test
    fun theReaderLinePrefixesTheSameCounts() {
        assertEquals(
            "Downloading voice 12 of 63 MB",
            SynthUiState.DownloadingVoice(12L * 1024 * 1024, 63L * 1024 * 1024).fillLine(),
        )
        assertEquals(
            "Preparing audio · 24 of 210 paragraphs",
            SynthUiState.Filling(24, 210).fillLine(),
        )
        assertEquals(
            "Preparing audio · 24 of 210 paragraphs",
            SynthUiState.Synthesizing(24, 210).fillLine(),
        )
        assertEquals("Preparing audio…", SynthUiState.Writing.fillLine())
        assertEquals("Downloading voice…", SynthUiState.DownloadingVoice(0, 0).fillLine())
        assertNull(SynthUiState.Done("bk", "/books/bk.taletrek").fillLine())
    }
}
