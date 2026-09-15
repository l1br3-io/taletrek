package dev.l1br3.taletrek.ui.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The outline's derived state — pure helpers, no Compose/Robolectric (the
 * rendering is dumb; these decide everything the locked reader-page design
 * specifies: honest "Chapter n of N" header, a muted ordinal on every row,
 * the "Now reading" marker on the current row only).
 */
class OutlineSheetTest {
    @Test
    fun headerCountsFromOneAndNamesTheTotal() {
        assertEquals("Chapter 1 of 2", outlineHeader(current = 0, count = 2))
        assertEquals("Chapter 2 of 2", outlineHeader(current = 1, count = 2))
    }

    @Test
    fun singleChapterBookIsHonest() {
        assertEquals("Chapter 1 of 1", outlineHeader(current = 0, count = 1))
    }

    @Test
    fun everyRowCarriesAnOrdinalAndOnlyCurrentIsMarked() {
        val rows = List(3) { index -> outlineRow(index, current = 1) }
        assertEquals(listOf(1, 2, 3), rows.map { it.ordinal })
        assertEquals(listOf(false, true, false), rows.map { it.isCurrent })
    }

    @Test
    fun outOfBoundsCurrentMarksNothing() {
        listOf(-1, 3).forEach { current ->
            val rows = List(3) { index -> outlineRow(index, current) }
            assertTrue(rows.none { it.isCurrent })
        }
    }
}
