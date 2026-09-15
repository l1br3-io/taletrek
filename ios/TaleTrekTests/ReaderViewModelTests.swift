import XCTest
@testable import TaleTrek

/// The reader's state owner over the real kernel + a faked engine
/// surface: open/restore flows, the follow policy, jump-to-chapter, and
/// the position save cadence. Sequencing assertions ride the kernel's
/// own semantics (the same discipline as the bridge tests).
@MainActor
final class ReaderViewModelTests: XCTestCase {
    private final class RecordingPort: AudioPort {
        var loads: [(key: String, offset: Double)] = []
        var stops = 0

        func playSegment(key: String, offset: Double) {
            loads.append((key, offset))
        }

        func stopOutput() {
            stops += 1
        }
    }

    private func book(chapterTexts: [[String]], audio: Bool = true) -> FfiBook {
        FfiBook(
            bookId: "bk_test",
            title: "Test Book",
            voiceId: "v",
            audioPresent: audio,
            chapters: chapterTexts.enumerated().map { chapterOrdinal, texts in
                FfiChapter(
                    id: "ch_\(chapterOrdinal)",
                    title: "Chapter \(chapterOrdinal + 1)",
                    paragraphs: texts.enumerated().map { index, text in
                        FfiParagraph(
                            id: "ch_\(chapterOrdinal):\(index)",
                            text: text,
                            segmentKey: "k-\(chapterOrdinal)-\(index)"
                        )
                    }
                )
            }
        )
    }

    private func tempStore() -> PositionStore {
        PositionStore(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("positions-\(UUID().uuidString).json")
        )
    }

    private func makeViewModel(
        _ book: FfiBook, store: PositionStore
    ) -> (viewModel: ReaderViewModel, port: RecordingPort, box: BridgeBox) {
        let port = RecordingPort()
        // The test keeps a handle on the bridge so platform reports can
        // be driven the way the engine would (ready, drained) — it
        // lands asynchronously, hence the box.
        let box = BridgeBox()
        let viewModel = ReaderViewModel(
            opener: { book },
            store: store,
            host: { book, saved in
                // Mirrors the production host: a surviving position
                // restores paused; none starts fresh.
                let kernel = saved.map { TrekPlayer.restore(book: book, position: $0.asFfi) }
                    ?? TrekPlayer(book: book)
                let bridge = PlayerBridge(kernel: kernel, port: port)
                box.bridge = bridge
                return bridge
            }
        )
        return (viewModel, port, box)
    }

    private final class BridgeBox {
        var bridge: PlayerBridge?
    }

    private func waitUntil(
        timeout: TimeInterval = 5, _ message: String, _ condition: @escaping () -> Bool
    ) {
        let fulfilled = expectation(description: message)
        let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { timer in
            if condition() {
                timer.invalidate()
                fulfilled.fulfill()
            }
        }
        wait(for: [fulfilled], timeout: timeout)
        timer.invalidate()
    }

    private func openAndHold(
        _ book: FfiBook, store: PositionStore
    ) -> (viewModel: ReaderViewModel, port: RecordingPort, bridge: PlayerBridge) {
        let (viewModel, port, box) = makeViewModel(book, store: store)
        waitUntil("the book opens") { !viewModel.state.loading }
        return (viewModel, port, box.bridge!)
    }

    func testOpeningRendersChaptersAndDerivesAnIdleTransport() {
        let book = book(chapterTexts: [["One.", "Two."], ["Three."]])
        let (viewModel, _, _) = openAndHold(book, store: tempStore())

        XCTAssertFalse(viewModel.state.loading)
        XCTAssertFalse(viewModel.state.missing)
        XCTAssertEqual(viewModel.state.bookTitle, "Test Book")
        XCTAssertEqual(viewModel.state.chapters.map(\.title), ["Chapter 1", "Chapter 2"])
        XCTAssertEqual(viewModel.state.status, .idle)
        XCTAssertTrue(viewModel.state.transport.canPlayPause, "audio book: play available")
        XCTAssertFalse(viewModel.state.transport.playing)
    }

    func testPlayLoadsTheFirstParagraphAndSavesThePosition() {
        let book = book(chapterTexts: [["One.", "Two."]])
        let store = tempStore()
        let (viewModel, port, bridge) = openAndHold(book, store: store)

        viewModel.play()
        waitUntil("playing the first paragraph") { viewModel.state.status == .playing }
        XCTAssertEqual(port.loads.map(\.key), ["k-0-0"])
        let key = positionStorageKey(bookId: "bk_test")
        XCTAssertEqual(
            store.load(storageKey: key),
            StoredPosition(chapter: 0, index: 0, offset: 0)
        )

        bridge.onReady(key: "k-0-0")
        bridge.onSegmentDrained(key: "k-0-0")
        waitUntil("advanced to the second paragraph") {
            viewModel.state.active?.index == 1
        }
        XCTAssertEqual(
            store.load(storageKey: key),
            StoredPosition(chapter: 0, index: 1, offset: 0),
            "the save cadence rides paragraph advances"
        )
    }

    func testARestoredPositionSeedsPausedAtItsChapter() {
        let book = book(chapterTexts: [["One."], ["Two."]])
        let store = tempStore()
        store.save(
            storageKey: positionStorageKey(bookId: "bk_test"),
            StoredPosition(chapter: 1, index: 0, offset: 0.5)
        )

        let (viewModel, port, _) = openAndHold(book, store: store)

        XCTAssertEqual(viewModel.state.status, .paused)
        XCTAssertEqual(viewModel.state.renderedChapter, 1, "the pane opens on the saved chapter")
        XCTAssertEqual(viewModel.state.active?.chapter, 1)
        XCTAssertTrue(port.loads.isEmpty, "a restore never commands audio")
    }

    func testAStrayRestorePositionSeedsFreshIdle() {
        let book = book(chapterTexts: [["One."]])
        let store = tempStore()
        store.save(
            storageKey: positionStorageKey(bookId: "bk_test"),
            StoredPosition(chapter: 99, index: 99, offset: 9.0)
        )

        let (viewModel, _, _) = openAndHold(book, store: store)

        XCTAssertEqual(viewModel.state.status, .idle, "no phantom resume")
        XCTAssertNil(viewModel.state.active)
        XCTAssertEqual(viewModel.state.renderedChapter, 0)
    }

    func testJumpToChapterSeeksRendersAndPulsesTheLanding() {
        let book = book(chapterTexts: [["One."], ["Two.", "Tail."]])
        let (viewModel, port, _) = openAndHold(book, store: tempStore())

        viewModel.jumpToChapter(1)

        XCTAssertEqual(viewModel.state.renderedChapter, 1)
        XCTAssertEqual(
            viewModel.state.landing,
            FfiParagraphPos(chapter: 1, index: 0),
            "the landing pulse targets the chapter's first paragraph"
        )
        XCTAssertEqual(port.loads.map(\.key), ["k-1-0"], "idle + seek starts playback there")
        waitUntil("the landing pulse clears") { viewModel.state.landing == nil }
    }

    func testFollowDefersOnUserScrollAndRearmsOnTheNextParagraph() {
        let book = book(chapterTexts: [["One.", "Two."], ["Three."]])
        let (viewModel, _, bridge) = openAndHold(book, store: tempStore())

        viewModel.play()
        waitUntil("playing") { viewModel.state.status == .playing }

        viewModel.onUserScrolled()
        XCTAssertFalse(viewModel.state.follow)

        bridge.onReady(key: "k-0-0")
        bridge.onSegmentDrained(key: "k-0-0")
        waitUntil("advanced + re-armed") {
            viewModel.state.active?.index == 1 && viewModel.state.follow
        }
    }

    func testAChapterCrossingSwitchesTheRenderedChapter() {
        let book = book(chapterTexts: [["One."], ["Two."]])
        let (viewModel, _, bridge) = openAndHold(book, store: tempStore())

        viewModel.play()
        waitUntil("playing") { viewModel.state.status == .playing }
        bridge.onReady(key: "k-0-0")
        bridge.onSegmentDrained(key: "k-0-0")
        waitUntil("the spoken chapter renders") {
            viewModel.state.renderedChapter == 1
        }
        XCTAssertEqual(viewModel.state.chapters[viewModel.state.renderedChapter].title, "Chapter 2")
    }

    func testATextOnlyBookRendersInert() {
        let quiet = book(chapterTexts: [["Words."]], audio: false)
        let (viewModel, port, _) = openAndHold(quiet, store: tempStore())

        viewModel.play()
        XCTAssertFalse(viewModel.state.transport.canPlayPause)
        XCTAssertTrue(port.loads.isEmpty)
        XCTAssertEqual(viewModel.state.status, .idle)
    }

    func testAMissingBookSurfacesTheMissingState() {
        let viewModel = ReaderViewModel(
            opener: { throw NSError(domain: "test", code: 1) },
            store: tempStore(),
            host: { book, _ in
                PlayerBridge(kernel: TrekPlayer(book: book), port: RecordingPort())
            }
        )
        waitUntil("the open fails") { !viewModel.state.loading }
        XCTAssertTrue(viewModel.state.missing)
    }
}
