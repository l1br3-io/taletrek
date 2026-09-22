import MediaPlayer
import XCTest
@testable import TaleTrek

/// The reader's state owner over the real kernel + a faked engine
/// surface: open/restore flows, the follow policy, jump-to-chapter, the
/// position save cadence, and the interruption route (pause through the
/// kernel; resume only by invitation and only if playing was
/// interrupted). Sequencing assertions ride the kernel's own semantics
/// (the same discipline as the bridge tests).
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

    private final class FakeInterruptionSource: InterruptionSource {
        var handler: ((AudioInterruption) -> Void)?

        func observe(_ handler: @escaping (AudioInterruption) -> Void) {
            self.handler = handler
        }

        func fire(_ event: AudioInterruption) {
            handler?(event)
        }
    }

    private final class RecordingNowPlayingSink: NowPlayingInfoSink {
        private(set) var infos: [[String: Any]] = []

        func setInfo(_ info: [String: Any]) {
            infos.append(info)
        }
    }

    private final class StubRemoteCommand: RemoteCommand {
        var isEnabled = true

        func setHandler(_ handler: @escaping () -> Void) {}
    }

    private final class StubRemoteRegistry: RemoteCommandRegistry {
        let play: RemoteCommand = StubRemoteCommand()
        let pause: RemoteCommand = StubRemoteCommand()
        let togglePlayPause: RemoteCommand = StubRemoteCommand()
        let nextTrack: RemoteCommand = StubRemoteCommand()
        let previousTrack: RemoteCommand = StubRemoteCommand()
        let changePlaybackPosition: RemoteCommand = StubRemoteCommand()
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

    /// The wired harness: view model + recording port + the bridge once
    /// the open lands (SwiftLint keeps tuples at two members; this is
    /// four facts).
    private struct Harness {
        let viewModel: ReaderViewModel
        let port: RecordingPort
        var box: BridgeBox
        var interruptions: FakeInterruptionSource
        var nowPlayingSink: RecordingNowPlayingSink
    }

    private final class BridgeBox {
        var bridge: PlayerBridge?
    }

    private func makeViewModel(
        _ book: FfiBook, store: PositionStore
    ) -> Harness {
        let port = RecordingPort()
        let interruptions = FakeInterruptionSource()
        let nowPlayingSink = RecordingNowPlayingSink()
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
            },
            nowPlayingHost: { bridge in
                NowPlayingController(
                    target: bridge,
                    infoSink: nowPlayingSink,
                    registry: StubRemoteRegistry()
                )
            },
            interruptionSource: interruptions
        )
        return Harness(
            viewModel: viewModel,
            port: port,
            box: box,
            interruptions: interruptions,
            nowPlayingSink: nowPlayingSink
        )
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
    ) -> Harness {
        let harness = makeViewModel(book, store: store)
        waitUntil("the book opens") { !harness.viewModel.state.loading }
        return harness
    }

    func testOpeningRendersChaptersAndDerivesAnIdleTransport() {
        let book = book(chapterTexts: [["One.", "Two."], ["Three."]])
        let viewModel = openAndHold(book, store: tempStore()).viewModel

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
        let harness = openAndHold(book, store: store)
        let viewModel = harness.viewModel

        viewModel.play()
        waitUntil("playing the first paragraph") { viewModel.state.status == .playing }
        XCTAssertEqual(harness.port.loads.map(\.key), ["k-0-0"])
        let key = positionStorageKey(bookId: "bk_test")
        XCTAssertEqual(
            store.load(storageKey: key),
            StoredPosition(chapter: 0, index: 0, offset: 0)
        )

        guard let bridge = harness.box.bridge else {
            XCTFail("the bridge never landed")
            return
        }
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

        let harness = openAndHold(book, store: store)
        let viewModel = harness.viewModel

        XCTAssertEqual(viewModel.state.status, .paused)
        XCTAssertEqual(viewModel.state.renderedChapter, 1, "the pane opens on the saved chapter")
        XCTAssertEqual(viewModel.state.active?.chapter, 1)
        XCTAssertTrue(harness.port.loads.isEmpty, "a restore never commands audio")
    }

    func testAStrayRestorePositionSeedsFreshIdle() {
        let book = book(chapterTexts: [["One."]])
        let store = tempStore()
        store.save(
            storageKey: positionStorageKey(bookId: "bk_test"),
            StoredPosition(chapter: 99, index: 99, offset: 9.0)
        )

        let viewModel = openAndHold(book, store: store).viewModel

        XCTAssertEqual(viewModel.state.status, .idle, "no phantom resume")
        XCTAssertNil(viewModel.state.active)
        XCTAssertEqual(viewModel.state.renderedChapter, 0)
    }

    func testJumpToChapterSeeksRendersAndPulsesTheLanding() {
        let book = book(chapterTexts: [["One."], ["Two.", "Tail."]])
        let harness = openAndHold(book, store: tempStore())
        let viewModel = harness.viewModel

        viewModel.jumpToChapter(1)

        XCTAssertEqual(viewModel.state.renderedChapter, 1)
        XCTAssertEqual(
            viewModel.state.landing,
            FfiParagraphPos(chapter: 1, index: 0),
            "the landing pulse targets the chapter's first paragraph"
        )
        XCTAssertEqual(harness.port.loads.map(\.key), ["k-1-0"], "idle + seek starts playback there")
        waitUntil("the landing pulse clears") { viewModel.state.landing == nil }
    }

    func testFollowDefersOnUserScrollAndRearmsOnTheNextParagraph() {
        let book = book(chapterTexts: [["One.", "Two."], ["Three."]])
        let harness = openAndHold(book, store: tempStore())
        let viewModel = harness.viewModel

        viewModel.play()
        waitUntil("playing") { viewModel.state.status == .playing }

        viewModel.onUserScrolled()
        XCTAssertFalse(viewModel.state.follow)

        guard let bridge = harness.box.bridge else {
            XCTFail("the bridge never landed")
            return
        }
        bridge.onReady(key: "k-0-0")
        bridge.onSegmentDrained(key: "k-0-0")
        waitUntil("advanced + re-armed") {
            viewModel.state.active?.index == 1 && viewModel.state.follow
        }
    }

    func testAChapterCrossingSwitchesTheRenderedChapter() {
        let book = book(chapterTexts: [["One."], ["Two."]])
        let harness = openAndHold(book, store: tempStore())
        let viewModel = harness.viewModel

        viewModel.play()
        waitUntil("playing") { viewModel.state.status == .playing }
        guard let bridge = harness.box.bridge else {
            XCTFail("the bridge never landed")
            return
        }
        bridge.onReady(key: "k-0-0")
        bridge.onSegmentDrained(key: "k-0-0")
        waitUntil("the spoken chapter renders") {
            viewModel.state.renderedChapter == 1
        }
        XCTAssertEqual(viewModel.state.chapters[viewModel.state.renderedChapter].title, "Chapter 2")
    }

    func testATextOnlyBookRendersInert() {
        let quiet = book(chapterTexts: [["Words."]], audio: false)
        let harness = openAndHold(quiet, store: tempStore())
        let viewModel = harness.viewModel

        viewModel.play()
        XCTAssertFalse(viewModel.state.transport.canPlayPause)
        XCTAssertTrue(harness.port.loads.isEmpty)
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

    func testAnInterruptionPausesThroughTheKernelAndResumesWhenInvited() {
        let book = book(chapterTexts: [["One.", "Two."]])
        let harness = openAndHold(book, store: tempStore())
        let viewModel = harness.viewModel

        viewModel.play()
        waitUntil("playing") { viewModel.state.status == .playing }

        harness.interruptions.fire(.began)
        waitUntil("interrupted into a kernel pause") { viewModel.state.status == .paused }

        harness.interruptions.fire(.ended(shouldResume: true))
        waitUntil("resumed by the platform's invitation") { viewModel.state.status == .playing }
    }

    func testAnInterruptionWhilePausedNeverWakesTheBook() {
        let book = book(chapterTexts: [["One."]])
        let harness = openAndHold(book, store: tempStore())
        let viewModel = harness.viewModel

        viewModel.play()
        waitUntil("playing") { viewModel.state.status == .playing }
        viewModel.pause()
        waitUntil("paused by the user") { viewModel.state.status == .paused }

        harness.interruptions.fire(.began)
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        harness.interruptions.fire(.ended(shouldResume: true))
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        XCTAssertEqual(viewModel.state.status, .paused, "a resting reader stays resting")
    }

    func testNowPlayingContentRidesTheSnapshot() {
        let book = book(chapterTexts: [["One."], ["Two."]])
        let harness = openAndHold(book, store: tempStore())
        let viewModel = harness.viewModel

        viewModel.play()
        waitUntil("playing") { viewModel.state.status == .playing }

        let titled = harness.nowPlayingSink.infos.filter {
            $0[MPMediaItemPropertyTitle] as? String == "Test Book"
        }
        XCTAssertTrue(!titled.isEmpty, "the lock screen learns the book")
        XCTAssertEqual(titled.last?[MPMediaItemPropertyAlbumTitle] as? String, "Chapter 1")
        XCTAssertEqual(titled.last?[MPPlaybackRate] as? Double, 1.0)
    }
}
