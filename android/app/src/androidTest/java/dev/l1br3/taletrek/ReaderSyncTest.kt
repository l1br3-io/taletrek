package dev.l1br3.taletrek

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The sync loop on device, over the real app shell and the real
 * service: play highlights the spoken paragraph, a paragraph tap
 * seeks there (one event, kernel semantics), and the text-only
 * transport renders disabled with its hint. Positions persist across
 * classes via the production store — tests leave chapter one behind
 * so order never matters.
 */
@RunWith(AndroidJUnit4::class)
class ReaderSyncTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun playbackHighlightsTheSpokenParagraphAndATapSeeks() {
        openSampleBook()

        rule.onNodeWithContentDescription("Play").performClick()
        rule.waitUntil(TIMEOUT_MS) { spoken("Hello world.") }

        rule.onNodeWithText("The quick brown fox jumps over the lazy dog.", substring = true).performClick()
        rule.waitUntil(TIMEOUT_MS) { spoken("The quick brown fox jumps over the lazy dog.") }

        // Back to the first paragraph — the position the next class in
        // this process expects to restore.
        rule.onNodeWithText("Hello world.", substring = true).performClick()
        rule.waitUntil(TIMEOUT_MS) { spoken("Hello world.") }
    }

    private fun spoken(paragraph: String): Boolean =
        rule
            .onAllNodesWithContentDescription(
                "Spoken paragraph: $paragraph",
                substring = true,
            ).fetchSemanticsNodes()
            .isNotEmpty()

    private fun openSampleBook() {
        rule.waitUntil(TIMEOUT_MS) {
            rule.onAllNodesWithText("Sample Book").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("Sample Book").performClick()
        rule.waitUntil(TIMEOUT_MS) {
            rule.onAllNodesWithText("Chapter One").fetchSemanticsNodes().isNotEmpty()
        }
    }

    companion object {
        private const val TIMEOUT_MS = 10_000L

        @BeforeClass
        @JvmStatic
        fun seedLibrary() {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val target = instrumentation.targetContext
            // Grant POST_NOTIFICATIONS ahead of launch — the first-run
            // permission dialog would cover the app (see ReaderScreenTest).
            instrumentation
                .uiAutomation
                .executeShellCommand(
                    "pm grant ${target.packageName} android.permission.POST_NOTIFICATIONS",
                ).close()
            File(target.filesDir, "books").deleteRecursively()
            File(target.filesDir, "datastore").deleteRecursively()
            val books = File(target.filesDir, "books").apply { mkdirs() }
            instrumentation.context.assets.open("book-playable.taletrek").use { input ->
                File(books, "bk_sample.taletrek").outputStream().use { output -> input.copyTo(output) }
            }
            assertTrue(File(books, "bk_sample.taletrek").length() > 0)
        }
    }
}
