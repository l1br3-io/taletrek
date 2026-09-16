package dev.l1br3.taletrek.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The export intent builders' pure half — filenames, MIME types, the
 * provider authority. The android.*-touching halves (Uri, Intent) need a
 * device; their shape is covered by the instrumented export test.
 */
class ExportFilesTest {
    @Test
    fun theProviderAuthorityIsTheManifestRegisteredOne() {
        assertEquals("dev.l1br3.taletrek.export", ExportFiles.AUTHORITY)
    }

    @Test
    fun mimesAreZipForBundlesAndOggForAudio() {
        assertEquals("application/zip", ExportKind.BUNDLE.mime)
        assertEquals("audio/ogg", ExportKind.AUDIO.mime)
    }

    @Test
    fun suggestedNamesUseTheTitleAndTheKindExtension() {
        assertEquals(
            "My Book.taletrek",
            ExportFiles.suggestedFileName("bk_1", "My Book", ExportKind.BUNDLE),
        )
        assertEquals(
            "My Book.opus",
            ExportFiles.suggestedFileName("bk_1", "My Book", ExportKind.AUDIO),
        )
    }

    @Test
    fun pathShapedTitlesAreSanitizedToASingleComponent() {
        assertEquals(
            "a b c d.opus",
            ExportFiles.suggestedFileName("bk_1", "a/b\\c:d", ExportKind.AUDIO),
        )
    }

    @Test
    fun punctuationAndTrailingDotsDoNotSurvive() {
        assertEquals(
            "Hello, world.taletrek",
            ExportFiles.suggestedFileName("bk_1", "Hello, world?", ExportKind.BUNDLE),
        )
        assertEquals(
            "Draft.opus",
            ExportFiles.suggestedFileName("bk_1", "Draft...", ExportKind.AUDIO),
        )
    }

    @Test
    fun anEmptyTitleFallsBackToTheBookId() {
        assertEquals(
            "bk_fallback.opus",
            ExportFiles.suggestedFileName("bk_fallback", "   ", ExportKind.AUDIO),
        )
    }
}
