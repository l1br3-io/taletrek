import XCTest
@testable import TaleTrek

/// The library's repo over the real kernel (app-hosted — `openBook`
/// rides the test binary): scan shape, corrupt tolerance, the
/// copy-on-import contract (stage → validate → replace-by-id), and
/// delete's file+position pairing.
@MainActor
final class BooksRepoTests: XCTestCase {
    private var booksDir: URL!
    private var store: PositionStore!

    override func setUpWithError() throws {
        booksDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("books-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: booksDir, withIntermediateDirectories: true)
        store = PositionStore(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("positions-\(UUID().uuidString).json")
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: booksDir)
    }

    private func fixture(_ resource: String) throws -> URL {
        try XCTUnwrap(
            Bundle(for: BooksRepoTests.self).url(
                forResource: resource, withExtension: "taletrek"
            ),
            "fixture \(resource).taletrek rides the test bundle's resources"
        )
    }

    private func copyFixture(_ resource: String, as name: String) throws {
        try FileManager.default.copyItem(
            at: try fixture(resource),
            to: booksDir.appendingPathComponent(name)
        )
    }

    func testScanListsRowsSortedByTitle() throws {
        try copyFixture("book-playable", as: "sample.taletrek")

        let repo = BooksRepository(booksDir: booksDir, positions: store)

        XCTAssertEqual(repo.state.skipped, 0)
        XCTAssertEqual(repo.state.books.count, 1)
        let row = try XCTUnwrap(repo.state.books.first)
        XCTAssertEqual(row.bookId, "bk_sample")
        XCTAssertEqual(row.title, "Sample Book")
        XCTAssertEqual(row.chapterCount, 2)
        XCTAssertTrue(row.audioPresent)
    }

    func testScanSkipsCorruptBundlesWithoutDying() throws {
        try copyFixture("book-playable", as: "sample.taletrek")
        try Data("not a bundle at all".utf8).write(
            to: booksDir.appendingPathComponent("broken.taletrek")
        )

        let repo = BooksRepository(booksDir: booksDir, positions: store)

        XCTAssertEqual(repo.state.skipped, 1, "the corrupt bundle counts, nothing more")
        XCTAssertEqual(repo.state.books.map(\.bookId), ["bk_sample"], "the healthy row survives")
    }

    func testScanOfAnAbsentDirectoryIsAnEmptyLibrary() {
        let repo = BooksRepository(
            booksDir: booksDir.appendingPathComponent("never-created", isDirectory: true),
            positions: store
        )

        XCTAssertEqual(repo.state.books, [])
        XCTAssertEqual(repo.state.skipped, 0)
    }

    func testImportStagesValidatesAndLandsUnderTheBookId() throws {
        let repo = BooksRepository(booksDir: booksDir, positions: store)

        let outcome = repo.importFrom(try fixture("book-playable"))

        XCTAssertEqual(
            outcome,
            .imported(
                BookShelf(
                    bookId: "bk_sample",
                    title: "Sample Book",
                    author: "Fixture Generator",
                    chapterCount: 2,
                    audioPresent: true,
                    path: booksDir.appendingPathComponent("bk_sample.taletrek").path
                )
            )
        )
        XCTAssertEqual(repo.state.books.map(\.bookId), ["bk_sample"])
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: booksDir.appendingPathComponent("bk_sample.taletrek").path
            )
        )
    }

    func testReimportOfTheSameBundleIsAReplaceNotADuplicate() throws {
        let repo = BooksRepository(booksDir: booksDir, positions: store)
        _ = repo.importFrom(try fixture("book-playable"))

        // A position saved under the same id must survive the replace.
        let key = positionStorageKey(bookId: "bk_sample")
        store.save(storageKey: key, StoredPosition(chapter: 1, index: 0, offset: 1.5))

        _ = repo.importFrom(try fixture("book-playable"))

        XCTAssertEqual(repo.state.books.count, 1, "one entry, never two")
        XCTAssertEqual(
            store.load(storageKey: key),
            StoredPosition(chapter: 1, index: 0, offset: 1.5),
            "deterministic ids keep the place across a re-import"
        )
        XCTAssertNil(repo.lastImportFailure)
    }

    func testImportRejectsGarbageLeavingNoResidue() throws {
        let garbage = FileManager.default.temporaryDirectory
            .appendingPathComponent("garbage-\(UUID().uuidString).taletrek")
        try Data("definitely not a zip".utf8).write(to: garbage)
        defer { try? FileManager.default.removeItem(at: garbage) }

        let repo = BooksRepository(booksDir: booksDir, positions: store)
        let outcome = repo.importFrom(garbage)

        guard case .rejected = outcome else {
            return XCTFail("garbage must be rejected")
        }
        XCTAssertEqual(repo.state.books, [])
        let residue = try FileManager.default.contentsOfDirectory(atPath: booksDir.path)
        XCTAssertEqual(residue, [], "a rejected import leaves no residue")
        XCTAssertNotNil(repo.lastImportFailure)
    }

    func testDeleteRemovesTheFileAndItsPosition() throws {
        try copyFixture("book-playable", as: "bk_sample.taletrek")
        let repo = BooksRepository(booksDir: booksDir, positions: store)
        let row = try XCTUnwrap(repo.state.books.first)
        let key = positionStorageKey(bookId: row.bookId)
        store.save(storageKey: key, StoredPosition(chapter: 0, index: 1, offset: 2.0))

        repo.delete(row)

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: booksDir.appendingPathComponent("bk_sample.taletrek").path)
        )
        XCTAssertNil(store.load(storageKey: key), "the orphaned position goes with the file")
        XCTAssertEqual(repo.state.books, [])
    }

    // --- search (android-export-search parity) ----------------------------

    private func shelf(_ title: String, author: String? = nil) -> BookShelf {
        BookShelf(
            bookId: "bk_\(title)",
            title: title,
            author: author,
            chapterCount: 1,
            audioPresent: true,
            path: "/b/\(title).taletrek"
        )
    }

    func testSearchMatchesTitleAndAuthorCaseInsensitively() {
        let dune = shelf("Dune", author: "Frank Herbert")
        let messiah = shelf("Dune Messiah", author: "Frank Herbert")
        let martian = shelf("The Martian", author: "Andy Weir")

        XCTAssertTrue(dune.matches(query: "dune"), "title, case-insensitive")
        XCTAssertTrue(messiah.matches(query: "DUNE"), "substring, either side")
        XCTAssertTrue(dune.matches(query: "  herbert  "), "author, whitespace-tolerant")
        XCTAssertTrue(martian.matches(query: "weir"), "author match")
        XCTAssertFalse(martian.matches(query: "herbert"))
        XCTAssertTrue(dune.matches(query: ""), "empty query = the full shelf")
        XCTAssertTrue(dune.matches(query: "   "), "blank query = the full shelf")
        XCTAssertFalse(dune.matches(query: "arrakis"))
    }

    func testFilteredBooksDerivesTheShelfUnderTheQuery() throws {
        try copyFixture("book-playable", as: "bk_sample.taletrek")
        let repo = BooksRepository(booksDir: booksDir, positions: store)

        XCTAssertEqual(repo.filteredBooks("").count, 1, "empty query keeps the shelf")
        XCTAssertEqual(repo.filteredBooks("sample").map(\.bookId), ["bk_sample"], "title hit")
        XCTAssertEqual(repo.filteredBooks("nobody wrote this"), [], "no-match shelf is empty")
    }

    // --- export ------------------------------------------------------------

    func testMergedAudioExportProducesOneNonEmptyOpus() throws {
        try copyFixture("book-playable", as: "bk_sample.taletrek")
        let repo = BooksRepository(booksDir: booksDir, positions: store)
        let row = try XCTUnwrap(repo.state.books.first)

        let exported = expectation(description: "merged audio prepared")
        var prepared: URL?
        repo.prepareAudioExport(row) { url in
            prepared = url
            exported.fulfill()
        }
        wait(for: [exported], timeout: 30)

        let url = try XCTUnwrap(prepared, "the remux hands back its artifact")
        XCTAssertEqual(url.lastPathComponent, "bk_sample.opus")
        XCTAssertTrue(
            url.path.hasPrefix(BooksRepository.exportsDir.path),
            "merged audio lands under Caches/exports/"
        )
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int
        XCTAssertGreaterThan(size ?? 0, 0, "the merged .opus is non-empty")
        XCTAssertNil(repo.lastExportFailure)
        XCTAssertNil(repo.exportingBookId, "the transient state clears")

        try? FileManager.default.removeItem(at: url)
    }

    func testFailedAudioExportSurfacesTypedFailureAndClearsTheSlot() throws {
        // A corrupt "bundle" the scan already skipped — prepare it by
        // hand through the same seam with a bogus path.
        let repo = BooksRepository(booksDir: booksDir, positions: store)
        let ghost = BookShelf(
            bookId: "bk_ghost",
            title: "Ghost",
            author: nil,
            chapterCount: 1,
            audioPresent: true,
            path: booksDir.appendingPathComponent("missing.taletrek").path
        )

        let failed = expectation(description: "failure surfaced")
        var prepared: URL?
        repo.prepareAudioExport(ghost) { url in
            prepared = url
            failed.fulfill()
        }
        wait(for: [failed], timeout: 30)

        XCTAssertNil(prepared, "a failed remux produces nothing")
        XCTAssertNotNil(repo.lastExportFailure, "the typed failure surfaces")
        XCTAssertNil(repo.exportingBookId, "the slot frees for the next try")
    }

    // --- filling rows + convert card (android parity derivations) ------

    private func fillingShelf(audio: Bool = false) -> BookShelf {
        BookShelf(
            bookId: "bk_f",
            title: "Filling",
            author: nil,
            chapterCount: 1,
            audioPresent: audio,
            path: "/b/bk_f.taletrek"
        )
    }

    func testFillingRowDerivationMatchesTheParityRules() {
        let book = fillingShelf()
        let live: SynthUiState = .synthesizing(done: 3, total: 9)

        XCTAssertEqual(
            fillingRowUi(book: fillingShelf(audio: true), active: live, preExistingPaths: []),
            FillingRowUi(),
            "an audio row is never filling"
        )
        XCTAssertEqual(
            fillingRowUi(book: book, active: .idle, preExistingPaths: []),
            FillingRowUi(),
            "no live job: neutral"
        )
        XCTAssertEqual(
            fillingRowUi(book: book, active: live, preExistingPaths: [book.path]),
            FillingRowUi(),
            "a pre-existing text-only import stays neutral"
        )
        XCTAssertEqual(
            fillingRowUi(book: book, active: live, preExistingPaths: []).detail,
            "Preparing audio · 3 of 9 paragraphs",
            "a row the live job wrote renders the fill progress"
        )
        XCTAssertEqual(
            fillingRowUi(book: book, active: .filling(done: 9, total: 9), preExistingPaths: []).detail,
            "Preparing audio · 9 of 9 paragraphs",
            "filling carries the same currency post-Playable"
        )
        XCTAssertNil(
            fillingRowUi(book: book, active: .synthesizing(done: 0, total: 0), preExistingPaths: []).detail,
            "unknown totals render without the counts"
        )
        XCTAssertEqual(
            fillingRowUi(book: book, active: .downloadingVoice(done: 1, total: 2), preExistingPaths: []).detail,
            nil,
            "non-synth phases carry no paragraph counts"
        )
    }

    func testConvertCardVisibilityFollowsOneRowPerBook() {
        XCTAssertEqual(convertCardVisible(state: nil, fillingRowOnShelf: false, terminalDismissed: false), false)
        XCTAssertEqual(convertCardVisible(state: .idle, fillingRowOnShelf: false, terminalDismissed: false), false)
        XCTAssertEqual(
            convertCardVisible(state: .preparing(chapters: nil, paragraphs: nil), fillingRowOnShelf: false, terminalDismissed: false),
            true,
            "parse/voice phases: the card is the only feedback"
        )
        XCTAssertEqual(
            convertCardVisible(state: .filling(done: 1, total: 2), fillingRowOnShelf: true, terminalDismissed: false),
            false,
            "the filling row carries progress — the card hides"
        )
        XCTAssertEqual(
            convertCardVisible(state: .filling(done: 1, total: 2), fillingRowOnShelf: false, terminalDismissed: false),
            true,
            "row not on the shelf yet: the card holds"
        )
        XCTAssertEqual(
            convertCardVisible(state: .done(bookId: "b", bundlePath: "/b"), fillingRowOnShelf: true, terminalDismissed: false),
            true,
            "terminals keep the card until dismissed"
        )
        XCTAssertEqual(
            convertCardVisible(state: .done(bookId: "b", bundlePath: "/b"), fillingRowOnShelf: true, terminalDismissed: true),
            false
        )
    }
}
