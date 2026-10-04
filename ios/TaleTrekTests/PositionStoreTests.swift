import XCTest
@testable import TaleTrek

/// The position store's contract: round-trips, corruption tolerance
/// (a position is one fact, never a half-position; a corrupt file is
/// fresh state), and storage-key namespacing.
final class PositionStoreTests: XCTestCase {
    private func tempFile() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("positions-\(UUID().uuidString).json")
    }

    func testRoundTripsASavedPosition() {
        let store = PositionStore(fileURL: tempFile())
        let position = StoredPosition(chapter: 2, index: 4, offset: 1.25)

        store.save(storageKey: "taletrek.reader.position.bk_a", position)

        XCTAssertEqual(
            store.load(storageKey: "taletrek.reader.position.bk_a"),
            position
        )
    }

    func testKeysDoNotCollideAndClearRemovesOnlyOne() {
        let store = PositionStore(fileURL: tempFile())
        let keyA = "taletrek.reader.position.bk_a"
        let keyB = "taletrek.reader.position.bk_b"

        store.save(storageKey: keyA, StoredPosition(chapter: 0, index: 0, offset: 0))
        store.save(storageKey: keyB, StoredPosition(chapter: 3, index: 1, offset: 9.5))
        store.clear(storageKey: keyA)

        XCTAssertNil(store.load(storageKey: keyA))
        XCTAssertEqual(
            store.load(storageKey: keyB),
            StoredPosition(chapter: 3, index: 1, offset: 9.5)
        )
    }

    func testACorruptFileReadsAsFreshAndTheNextSaveHeals() throws {
        let url = tempFile()
        try Data("not json at all".utf8).write(to: url)
        let store = PositionStore(fileURL: url)

        XCTAssertNil(store.load(storageKey: "taletrek.reader.position.bk_a"))

        store.save(storageKey: "taletrek.reader.position.bk_a", StoredPosition(chapter: 0, index: 1, offset: 0.5))
        let healed = PositionStore(fileURL: url)
        XCTAssertEqual(
            healed.load(storageKey: "taletrek.reader.position.bk_a"),
            StoredPosition(chapter: 0, index: 1, offset: 0.5)
        )
    }

    func testAWrongTypedFieldReadsTheEntryAsAbsent() throws {
        let url = tempFile()
        let hostile = """
        {"taletrek.reader.position.bk_a": {"chapter": "two", "index": 0, "offset": 0.0}}
        """
        try Data(hostile.utf8).write(to: url)
        let store = PositionStore(fileURL: url)

        XCTAssertNil(store.load(storageKey: "taletrek.reader.position.bk_a"))
    }

    func testTheFfiMappingIsFieldForField() {
        let original = FfiPosition(chapter: 1, index: 2, offset: 3.5)
        let stored = StoredPosition(original)

        XCTAssertEqual(stored.asFfi, original)
    }
}
