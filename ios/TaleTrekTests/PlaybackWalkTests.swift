import AVFoundation
import XCTest
@testable import TaleTrek

/// Task 004's acceptance walk: the real kernel, the real decode hop, the
/// real `AVAudioEngine` — no fakes, no UI — over the committed real-audio
/// fixtures (3 × ~1 s segments). Timing rides the platform: each drain
/// fires when the simulator's render timeline actually finishes the
/// buffer, so the walk observes genuine audio-time ordering.
@MainActor
final class PlaybackWalkTests: XCTestCase {
    private func fixturePath(_ resource: String) throws -> String {
        let bundle = Bundle(for: PlaybackWalkTests.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: resource, withExtension: "taletrek"),
            "fixture \(resource).taletrek rides the test bundle's resources"
        )
        return url.path
    }

    private func makeBridge(resource: String) throws -> (bridge: PlayerBridge, engine: AudioEngine) {
        let path = try fixturePath(resource)
        let book = try openBook(path: path)
        let engine = AudioEngine(path: path)
        let bridge = PlayerBridge(kernel: TrekPlayer(book: book), port: engine)
        engine.attach(bridge)
        return (bridge, engine)
    }

    private func waitUntil(
        timeout: TimeInterval = 30, _ message: String, _ condition: @escaping () -> Bool
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

    func testPlaysTheWholeBookThroughToIdleWithoutUi() throws {
        let (bridge, engine) = try makeBridge(resource: "book-playable")

        XCTAssertEqual(engine.loadedSegments.count, 0)
        XCTAssertFalse(engine.isEngineRunning, "nothing started before the first play")

        bridge.userPlay()

        waitUntil("the first segment is playing") { bridge.snapshot.status == .playing }
        XCTAssertTrue(engine.isEngineRunning, "audio is live — the engine renders the segment")
        XCTAssertEqual(engine.loadedSegments.count, 1, "one paragraph, one load")

        waitUntil("the book drains to idle") { bridge.snapshot.status == .idle }
        XCTAssertEqual(
            engine.loadedSegments.count,
            3,
            "three paragraphs walked — every drain advanced the kernel"
        )
        XCTAssertEqual(bridge.snapshot.failures.skipped, 0, "nothing skipped")
        XCTAssertTrue(
            engine.isEngineRunning,
            "book end stops the node, never the engine — no teardown on transitions"
        )
    }

    func testSeekReAnchorsAndResumeReturnsToTheRecordedOffset() throws {
        let (bridge, engine) = try makeBridge(resource: "book-playable")

        bridge.userPlay()
        waitUntil("playing the first paragraph") { bridge.snapshot.status == .playing }

        bridge.userSeekWithinParagraph(offset: 0.4)
        waitUntil("the scrub re-anchored the segment") { engine.loadedSegments.count == 2 }
        XCTAssertEqual(engine.loadedSegments[0].key, engine.loadedSegments[1].key)
        XCTAssertEqual(engine.loadedSegments[1].offset, 0.4, "the re-anchor starts at the target")

        bridge.userPause()
        XCTAssertEqual(bridge.snapshot.status, .paused)

        bridge.userPlay()
        waitUntil("the resume reload landed") { engine.loadedSegments.count == 3 }
        XCTAssertEqual(
            engine.loadedSegments[2].offset,
            0.4,
            "resume reloads at the kernel-recorded offset"
        )
        XCTAssertEqual(bridge.snapshot.status, .playing)

        waitUntil("the resumed segment drains") { bridge.snapshot.status == .idle }
    }

    func testACorruptSegmentSkipsItsParagraphAndContinues() throws {
        let (bridge, engine) = try makeBridge(resource: "book-corrupt")

        bridge.userPlay()

        waitUntil("the book ends despite the garbage segment") {
            bridge.snapshot.status == .idle
        }
        XCTAssertEqual(
            engine.loadedSegments.count,
            2,
            "the corrupt paragraph never schedules; its neighbors do"
        )
        XCTAssertNotEqual(engine.loadedSegments[0].key, engine.loadedSegments[1].key)
        XCTAssertEqual(bridge.snapshot.failures.skipped, 1, "exactly one paragraph skipped")
        XCTAssertNotNil(bridge.snapshot.failures.lastError, "the failure log reflects the skip")
    }

    func testTheSessionIsPlaybackAndSurvivesTheWholeBook() throws {
        let (bridge, engine) = try makeBridge(resource: "book-playable")

        bridge.userPlay()

        waitUntil("playing") { bridge.snapshot.status == .playing }
        XCTAssertEqual(
            AVAudioSession.sharedInstance().category,
            .playback,
            "first play activated the .playback category"
        )
        waitUntil("the book finishes") { bridge.snapshot.status == .idle }
        XCTAssertEqual(
            AVAudioSession.sharedInstance().category,
            .playback,
            "no teardown on book end (nor on transitions within the host)"
        )
        XCTAssertTrue(engine.isEngineRunning)
    }
}
