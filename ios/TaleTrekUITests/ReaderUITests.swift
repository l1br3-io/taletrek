import XCTest

/// The reader's simulator integration pass (task 005): rendering,
/// highlight tracking over REAL drains (the walk's audio timeline, now
/// through SwiftUI), the locked outline design, text-only inertness,
/// and position restore across a relaunch.
final class ReaderUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(resource: String, resetting: Bool = true) throws -> XCUIApplication {
        let url = try XCTUnwrap(
            Bundle(for: ReaderUITests.self).url(forResource: resource, withExtension: "taletrek"),
            "fixture \(resource).taletrek rides the UI-test bundle's resources"
        )
        let app = XCUIApplication()
        app.launchEnvironment["TALETREK_OPEN_BOOK"] = url.path
        if resetting {
            app.launchEnvironment["TALETREK_RESET_POSITIONS"] = "1"
        }
        app.launch()
        return app
    }

    func testRendersTracksHighlightAndTheOutlineNavigates() throws {
        let app = try launch(resource: "book-playable")

        XCTAssertTrue(app.staticTexts["reader-title"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["chapter-title"].label, "Chapter One")

        // Play: the spoken-paragraph highlight appears and tracks the
        // drains (real audio time on the simulator).
        app.buttons["transport-play"].tap()
        XCTAssertTrue(
            app.staticTexts["spoken-paragraph"].waitForExistence(timeout: 15),
            "the highlight follows playback"
        )

        // The outline, per the locked reader-page design.
        app.buttons["Chapters"].tap()
        let header = app.staticTexts["outline-header"]
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        XCTAssertEqual(header.label, "Chapter 1 of 2")
        app.staticTexts["chapter-row-1"].tap()

        // Jump dismissed the sheet and rendered chapter two's title.
        XCTAssertEqual(app.staticTexts["chapter-title"].label, "Chapter Two")
    }

    func testOutlineMarksTheCurrentChapter() throws {
        let app = try launch(resource: "book-playable")
        XCTAssertTrue(app.staticTexts["chapter-title"].waitForExistence(timeout: 15))

        app.buttons["Chapters"].tap()
        let row = app.staticTexts["chapter-row-0"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertEqual(row.label, "Chapter 1: Chapter One")
        XCTAssertTrue(
            app.staticTexts["Now reading"].waitForExistence(timeout: 5),
            "the current chapter carries the marker"
        )
    }

    func testTextOnlyRendersWithAnInertTransportAndWorkingOutline() throws {
        let app = try launch(resource: "book-text-only")

        XCTAssertTrue(app.staticTexts["chapter-title"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["transport-play"].isEnabled)
        XCTAssertTrue(
            app.staticTexts["Text-only bundle — no audio to play."].waitForExistence(timeout: 5)
        )

        // Navigation is audio-independent: the outline still opens.
        app.buttons["Chapters"].tap()
        XCTAssertTrue(app.staticTexts["outline-header"].waitForExistence(timeout: 5))
    }

    func testPositionRestoresAcrossARelaunch() throws {
        let app = try launch(resource: "book-playable")
        XCTAssertTrue(app.staticTexts["chapter-title"].waitForExistence(timeout: 15))

        // Tap chapter one's second paragraph — seek-from-idle starts
        // playback there and saves the position.
        app.staticTexts.matching(identifier: "paragraph").element(boundBy: 1).tap()
        XCTAssertTrue(
            app.staticTexts["spoken-paragraph"].waitForExistence(timeout: 15),
            "the tapped paragraph is spoken"
        )

        app.terminate()

        // Relaunch WITHOUT the reset — the saved position must survive
        // the kill: same paragraph, paused (Play, not Pause).
        let relaunched = try launch(resource: "book-playable", resetting: false)
        XCTAssertTrue(
            relaunched.staticTexts["spoken-paragraph"].waitForExistence(timeout: 15),
            "the highlight restores to the saved paragraph"
        )
        XCTAssertEqual(relaunched.buttons["transport-play"].label, "Play")
    }
}
