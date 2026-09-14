package dev.l1br3.taletrek.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The single-pick lane router over fakes-free pure input — extension
 * decides bundles, the convert lane is the safe default (the kernel's
 * content sniffing arbitrates unknowns).
 */
class SourceImportTest {
    @Test
    fun taletrekNamesRouteToBundleImport() {
        assertEquals(PickedLane.BUNDLE, SourceImport.laneOf("book.taletrek"))
        assertEquals(PickedLane.BUNDLE, SourceImport.laneOf("My Book.TALETREK"))
        assertEquals(PickedLane.BUNDLE, SourceImport.laneOf("a book.name.taletrek"))
    }

    @Test
    fun everythingElseRoutesToConvert() {
        assertEquals(PickedLane.SOURCE, SourceImport.laneOf("novel.epub"))
        assertEquals(PickedLane.SOURCE, SourceImport.laneOf("paper.pdf"))
        assertEquals(PickedLane.SOURCE, SourceImport.laneOf("notes.txt"))
        assertEquals(PickedLane.SOURCE, SourceImport.laneOf("book.taletrek.txt"))
        assertEquals(PickedLane.SOURCE, SourceImport.laneOf("no-extension"))
        assertEquals(PickedLane.SOURCE, SourceImport.laneOf(""))
        assertEquals(PickedLane.SOURCE, SourceImport.laneOf(null))
    }
}
