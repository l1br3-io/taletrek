import XCTest

/// The library's simulator pass (task 007): the fresh-install empty
/// state, and the seeded scan → row → reader flow (Checkpoint C's
/// pre-conversion story). The importer's system UI is repo-tested +
/// manual; the scan root rides the `TALETREK_BOOKS_DIR` seam.
final class LibraryUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func makeBooksDir(seedFixture: Bool) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("ui-books-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        if seedFixture {
            let fixture = try XCTUnwrap(
                Bundle(for: LibraryUITests.self).url(
                    forResource: "book-playable", withExtension: "taletrek"
                )
            )
            try FileManager.default.copyItem(
                at: fixture, to: url.appendingPathComponent("bk_sample.taletrek")
            )
        }
        return url
    }

    private func launch(booksDir: URL) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["TALETREK_BOOKS_DIR"] = booksDir.path
        app.launchEnvironment["TALETREK_RESET_POSITIONS"] = "1"
        app.launch()
        return app
    }

    func testFreshInstallShowsTheEmptyState() throws {
        let app = try launch(booksDir: makeBooksDir(seedFixture: false))

        XCTAssertTrue(
            app.otherElements["library-empty"].waitForExistence(timeout: 10),
            "no books, no skipped — the fresh-install empty state"
        )
        XCTAssertTrue(app.buttons["Import book"].exists)
    }

    func testASeededRowOpensTheReader() throws {
        let app = try launch(booksDir: makeBooksDir(seedFixture: true))

        let row = app.buttons["library-row-bk_sample"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the scan surfaces the manifest row")
        row.tap()

        let title = app.staticTexts["reader-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        XCTAssertEqual(title.label, "Sample Book")
    }
}
