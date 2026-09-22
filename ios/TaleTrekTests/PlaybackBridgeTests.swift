import XCTest
@testable import TaleTrek

/// The bridge's mapping discipline over a faked engine surface (the spec's
/// Swift-unit bar): the kernel is REAL — `TrekPlayer` over inline books —
/// so every assertion exercises true kernel sequencing, while the port,
/// session, and (for the engine suites) the decoder are scripted. The
/// same-key race fixture mirrors the desktop's: duplicate texts share
/// segment keys.
@MainActor
final class PlaybackBridgeTests: XCTestCase {
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

    private struct SessionUnavailable: Error {}

    private final class StubSession: PlaybackSession {
        var activated = 0
        var failure: Error?

        func activateForPlayback() throws {
            activated += 1
            if let failure {
                throw failure
            }
        }
    }

    /// A one-chapter book over `texts`; the segment key derives from the
    /// text so duplicate paragraphs share keys (the race fixture).
    private func book(texts: [String], audio: Bool = true) -> FfiBook {
        FfiBook(
            bookId: "bk_test",
            title: "Test Book",
            author: nil,
            voiceId: "v",
            audioPresent: audio,
            chapters: [
                FfiChapter(
                    id: "ch_0",
                    title: "One",
                    paragraphs: texts.enumerated().map { index, text in
                        FfiParagraph(id: "ch_0:\(index)", text: text, segmentKey: "k-\(text)")
                    }
                )
            ]
        )
    }

    private func makeBridge(
        _ book: FfiBook, port: RecordingPort, session: StubSession
    ) -> PlayerBridge {
        PlayerBridge(kernel: TrekPlayer(book: book), port: port, session: session)
    }

    // --- transport → action mapping ---------------------------------------

    func testPlayOrdersTheFirstSegmentAtZeroAndActivatesTheSessionOnce() {
        let book = book(texts: ["One.", "Two."])
        let port = RecordingPort()
        let session = StubSession()
        let bridge = makeBridge(book, port: port, session: session)

        bridge.userPlay()

        XCTAssertEqual(port.loads.map(\.key), ["k-One."])
        XCTAssertEqual(port.loads.map(\.offset), [0.0])
        XCTAssertEqual(port.stops, 0)
        XCTAssertEqual(session.activated, 1, "first play activates .playback exactly once")
        XCTAssertEqual(bridge.snapshot.status, .playing)
        XCTAssertEqual(bridge.snapshot.para?.index, 0)
    }

    func testPauseStopsOutputAndResumeReloadsAtTheKernelRecordedOffset() {
        let book = book(texts: ["One.", "Two."])
        let port = RecordingPort()
        let bridge = makeBridge(book, port: port, session: StubSession())

        bridge.userPlay()
        bridge.userSeekWithinParagraph(offset: 0.4)
        XCTAssertEqual(port.loads.count, 2, "the scrub re-anchors: one initial load, one reload")
        XCTAssertEqual(port.loads[0].key, "k-One.")
        XCTAssertEqual(port.loads[0].offset, 0.0)
        XCTAssertEqual(port.loads[1].key, "k-One.")
        XCTAssertEqual(port.loads[1].offset, 0.4, "the scrub reload starts at the target offset")

        bridge.userPause()
        XCTAssertEqual(port.stops, 1)
        XCTAssertEqual(bridge.snapshot.status, .paused)

        bridge.userPlay()
        XCTAssertEqual(port.loads.count, 3)
        XCTAssertEqual(
            port.loads[2].offset,
            0.4,
            "resume reloads the segment at the recorded offset"
        )
        XCTAssertEqual(port.loads[2].key, "k-One.")
        XCTAssertEqual(bridge.snapshot.status, .playing)
    }

    // --- the race closure (layers 2 + 3) ----------------------------------

    func testADrainWhileALoadIsPendingIsDroppedUntilReadyClosesTheWindow() {
        let book = book(texts: ["Dup.", "Dup.", "Tail."])
        let port = RecordingPort()
        let bridge = makeBridge(book, port: port, session: StubSession())

        bridge.userPlay()
        XCTAssertEqual(port.loads.map(\.key), ["k-Dup."], "fixture: duplicate texts share keys")

        bridge.onSegmentDrained(key: "k-Dup.")
        XCTAssertEqual(
            bridge.snapshot.para?.index,
            0,
            "the pre-ack drain must not advance — it cannot be proven to be the new load's"
        )

        bridge.onReady(key: "k-Dup.")
        bridge.onSegmentDrained(key: "k-Dup.")
        XCTAssertEqual(
            bridge.snapshot.para?.index,
            1,
            "the post-ack drain belongs to the loaded segment — advance"
        )
    }

    func testALateDrainAfterAPauseIsAbsorbedByTheKernel() {
        let book = book(texts: ["One.", "Two."])
        let port = RecordingPort()
        let bridge = makeBridge(book, port: port, session: StubSession())

        bridge.userPlay()
        bridge.userPause()
        XCTAssertEqual(bridge.snapshot.status, .paused)

        bridge.onSegmentDrained(key: "k-One.")

        XCTAssertEqual(bridge.snapshot.status, .paused, "layer 3: Paused absorbs completions")
        XCTAssertEqual(bridge.snapshot.para?.index, 0)
    }

    // --- failures ----------------------------------------------------------

    func testASegmentFailureSkipsTheParagraphAndSurfacesInTheLog() {
        let book = book(texts: ["One.", "Two."])
        let port = RecordingPort()
        let bridge = makeBridge(book, port: port, session: StubSession())

        bridge.userPlay()
        bridge.onSegmentFailed(key: "k-One.", error: "corrupt opus")

        XCTAssertEqual(
            bridge.snapshot.para?.index,
            1,
            "the skip path advances past the failed paragraph"
        )
        XCTAssertEqual(bridge.snapshot.failures.skipped, 1)
        XCTAssertEqual(bridge.snapshot.failures.lastError, "corrupt opus")
        XCTAssertEqual(port.loads.map(\.key), ["k-One.", "k-Two."], "playback continues")
    }

    func testASessionActivationFailureDrainsThroughTheSkipPathToBookEnd() {
        let book = book(texts: ["One.", "Two."])
        let port = RecordingPort()
        let session = StubSession()
        session.failure = SessionUnavailable()
        let bridge = makeBridge(book, port: port, session: session)

        bridge.userPlay()

        XCTAssertTrue(port.loads.isEmpty, "nothing schedules without a session")
        XCTAssertEqual(
            bridge.snapshot.status,
            .idle,
            "every segment fails to load — the kernel fail-skips to book end"
        )
        XCTAssertEqual(bridge.snapshot.failures.skipped, 2, "both paragraphs rode the skip path")
        XCTAssertNotNil(bridge.snapshot.failures.lastError)
    }

    // --- book ends + tolerance ----------------------------------------------

    func testTheFinalDrainEndsTheBookWithAStop() {
        let book = book(texts: ["Only."])
        let port = RecordingPort()
        let bridge = makeBridge(book, port: port, session: StubSession())

        bridge.userPlay()
        bridge.onReady(key: "k-Only.")
        bridge.onSegmentDrained(key: "k-Only.")

        XCTAssertEqual(bridge.snapshot.status, .idle)
        XCTAssertEqual(port.stops, 1, "book end stops output")
        XCTAssertNil(bridge.position, "a finished book has nowhere to resume")
    }

    func testATextOnlyBookExecutesNothing() {
        let quiet = book(texts: ["Words."], audio: false)
        let port = RecordingPort()
        let bridge = makeBridge(quiet, port: port, session: StubSession())

        bridge.userPlay()
        bridge.userPause()
        bridge.userNextParagraph()

        XCTAssertEqual(bridge.snapshot.status, .idle)
        XCTAssertTrue(port.loads.isEmpty)
        XCTAssertEqual(port.stops, 0)
    }
}

/// The engine's generation epochs (layer 1 of the closure) over a
/// scripted decoder and a recording sink — failure and supersession paths
/// only, so no audio renders and `AVAudioEngine.start` never happens.
@MainActor
final class AudioEngineEpochTests: XCTestCase {
    private final class RecordingSink: EngineEventSink {
        var events: [String] = []

        func onReady(key: String) {
            events.append("ready:\(key)")
        }

        func onSegmentDrained(key: String) {
            events.append("drained:\(key)")
        }

        func onSegmentFailed(key: String, error: String) {
            events.append("failed:\(key):\(error)")
        }
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

    private func spinRunLoop(for interval: TimeInterval) {
        let quiet = expectation(description: "no further events")
        quiet.isInverted = true
        wait(for: [quiet], timeout: interval)
    }

    func testADecodeFailureReportsThroughTheSinkWithTheKey() {
        let sink = RecordingSink()
        struct DecodeFailure: Error {}
        let engine = AudioEngine(path: "/dev/null") { _, _ in throw DecodeFailure() }
        engine.attach(sink)

        engine.playSegment(key: "k0", offset: 0)

        waitUntil("the failure reports") { sink.events.count == 1 }
        XCTAssertEqual(engine.loadedSegments.count, 0, "nothing scheduled")
        XCTAssertTrue(sink.events[0].hasPrefix("failed:k0:"), "the key and error cross")
    }

    func testAMissingSegmentReportsAsMissing() {
        let sink = RecordingSink()
        let engine = AudioEngine(path: "/dev/null") { _, _ in nil }
        engine.attach(sink)

        engine.playSegment(key: "k0", offset: 0)

        waitUntil("the miss reports") { sink.events.count == 1 }
        XCTAssertEqual(sink.events[0], "failed:k0:segment missing from bundle")
    }

    /// A full second of PCM — long enough that its natural drain cannot
    /// race the superseding command in the test window.
    private nonisolated func longAudio() -> FfiDecodedAudio {
        FfiDecodedAudio(samples: Array(repeating: 0, count: 24_000), sampleRate: 24_000, channels: 1)
    }

    /// The epoch invariant that is constructible through the public API:
    /// a scheduled buffer's completion is orphaned by the next command
    /// (`node.stop()` fires pending `.dataPlayedBack` handlers) and must
    /// never surface for the superseded schedule. Commands themselves are
    /// FIFO on the engine queue — mid-decode supersession is
    /// unrepresentable by construction, which is the point of the serial
    /// queue.
    func testAnOrphanedCompletionFromASupersededScheduleNeverSurfaces() {
        let sink = RecordingSink()
        let pcm = longAudio()
        let engine = AudioEngine(path: "/dev/null") { [pcm] _, _ in pcm }
        engine.attach(sink)

        engine.playSegment(key: "long", offset: 0)
        waitUntil("the long segment is armed") { sink.events.contains("ready:long") }
        engine.stopOutput()
        spinRunLoop(for: 0.5)
        XCTAssertEqual(
            sink.events,
            ["ready:long"],
            "the orphaned completion of the stopped schedule is dropped at the epoch"
        )

        engine.playSegment(key: "next", offset: 0)
        waitUntil("the next schedule arms") { sink.events.contains("ready:next") }
        spinRunLoop(for: 0.5)
        XCTAssertEqual(
            sink.events,
            ["ready:long", "ready:next"],
            "still no drain for the superseded schedule; the new one reports normally"
        )
        XCTAssertEqual(engine.loadedSegments.map(\.key), ["long", "next"])
    }
}
