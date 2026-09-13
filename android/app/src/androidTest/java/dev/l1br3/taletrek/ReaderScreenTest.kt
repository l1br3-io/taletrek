package dev.l1br3.taletrek

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
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
 * The reader's Compose walk on device, through the real app shell:
 * library tap -> per-chapter render -> outline jump -> back. The
 * text-only fixture rides the real kernel open (BookSession under the
 * hood) — position restores from the production store, so tests that
 * jump chapters jump back, keeping the class order-independent.
 */
@RunWith(AndroidJUnit4::class)
class ReaderScreenTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun libraryTapOpensTheReaderAtTheRestoredChapter() {
        openSampleBook()

        rule.onNodeWithText("Chapter One").assertIsDisplayed()
        rule.onNodeWithText("Hello world.", substring = true).assertIsDisplayed()
        rule.onNodeWithText("The quick brown fox jumps over the lazy dog.", substring = true).assertIsDisplayed()
    }

    @Test
    fun outlineJumpSwitchesTheRenderedChapter() {
        openSampleBook()

        rule.onNodeWithContentDescription("Chapters").performClick()
        rule.onNodeWithText("Chapter Two").performClick()

        rule.onNodeWithText("O’Reilly books are well worth reading.", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Hello world.", substring = true).assertDoesNotExist()

        // Leave the stored position back at chapter one — the class's
        // initial-chapter assertion stays order-independent.
        rule.onNodeWithContentDescription("Chapters").performClick()
        rule.onNodeWithText("Chapter One").performClick()
        rule.waitUntil(TIMEOUT_MS) {
            rule.onAllNodesWithText("Hello world.", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun aTextOnlyBundleRendersADisabledTransportWithTheHint() {
        openSampleBook()

        rule
            .onNodeWithText("Text-only bundle — no audio to play. Convert it on the desktop to listen.", substring = true)
            .assertIsDisplayed()
        rule.onNodeWithContentDescription("Play").assertIsNotEnabled()
        rule.onNodeWithContentDescription("Next paragraph").assertIsNotEnabled()
    }

    @Test
    fun backPopsToTheLibrary() {
        openSampleBook()
        rule.onNodeWithText("Chapter One").assertIsDisplayed()

        // The top-bar back button drives the same onBack the system
        // back resolves to (BackHandler) — both pop to the library.
        rule.onNodeWithContentDescription("Back to library").performClick()

        rule.waitUntil(TIMEOUT_MS) {
            rule.onAllNodesWithText("Library").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("Library").assertIsDisplayed()
    }

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
        private const val TIMEOUT_MS = 5_000L

        @BeforeClass
        @JvmStatic
        fun seedLibrary() {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val target = instrumentation.targetContext
            // The library asks for POST_NOTIFICATIONS on first composition —
            // on the fresh install every connected run starts with, that
            // system dialog covers the app and no compose hierarchy is ever
            // visible to the rule. Grant it before the activity launches.
            instrumentation
                .uiAutomation
                .executeShellCommand(
                    "pm grant ${target.packageName} android.permission.POST_NOTIFICATIONS",
                ).close()
            // Hermetic start: one known book, no stored positions (the
            // production store instance doesn't exist yet — safe to delete).
            File(target.filesDir, "books").deleteRecursively()
            File(target.filesDir, "datastore").deleteRecursively()
            val books = File(target.filesDir, "books").apply { mkdirs() }
            instrumentation.context.assets.open("book-text-only.taletrek").use { input ->
                File(books, "bk_sample.taletrek").outputStream().use { output -> input.copyTo(output) }
            }
            assertTrue(File(books, "bk_sample.taletrek").length() > 0)
        }
    }
}
