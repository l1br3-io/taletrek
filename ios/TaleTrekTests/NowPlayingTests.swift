import MediaPlayer
import XCTest
@testable import TaleTrek

/// The lock screen's half of the contract, hostable parts: info
/// assembly (the pure dictionary) and command routing (the locked set
/// through a faked registry + target). The MediaPlayer singletons stay
/// production-only.
@MainActor
final class NowPlayingTests: XCTestCase {
    private final class FakeTarget: RemoteCommandTarget {
        var playing = false
        private(set) var calls: [String] = []

        var isPlaying: Bool { playing }

        func play() {
            calls.append("play")
        }

        func pause() {
            calls.append("pause")
        }

        func nextChapter() {
            calls.append("next")
        }

        func prevChapter() {
            calls.append("prev")
        }
    }

    private final class FakeCommand: RemoteCommand {
        var isEnabled = true
        private var handler: (() -> Void)?

        func setHandler(_ handler: @escaping () -> Void) {
            self.handler = handler
        }

        func fire() {
            handler?()
        }
    }

    private final class FakeRegistry: RemoteCommandRegistry {
        let play = FakeCommand()
        let pause = FakeCommand()
        let togglePlayPause = FakeCommand()
        let nextTrack = FakeCommand()
        let previousTrack = FakeCommand()
        let changePlaybackPosition = FakeCommand()
    }

    private final class RecordingSink: NowPlayingInfoSink {
        private(set) var infos: [[String: Any]] = []

        func setInfo(_ info: [String: Any]) {
            infos.append(info)
        }
    }

    /// The wired rig (SwiftLint keeps tuples at two members; this is
    /// four facts).
    private struct Rig {
        let controller: NowPlayingController
        let target: FakeTarget
        let registry: FakeRegistry
        let sink: RecordingSink
    }

    private func makeRig() -> Rig {
        let target = FakeTarget()
        let registry = FakeRegistry()
        let sink = RecordingSink()
        return Rig(
            controller: NowPlayingController(
                target: target,
                infoSink: sink,
                registry: registry
            ),
            target: target,
            registry: registry,
            sink: sink
        )
    }

    func testInfoAssemblyCarriesTheLockedCurrency() {
        let info = NowPlayingInfo.make(
            content: NowPlayingContent(
                title: "Test Book",
                chapterTitle: "Chapter 2",
                chapterNumber: 2,
                chapterCount: 5
            ),
            times: SegmentTimes(duration: 12.5, elapsed: 3.25),
            playing: true
        )

        XCTAssertEqual(info[MPMediaItemPropertyTitle] as? String, "Test Book")
        XCTAssertEqual(info[MPMediaItemPropertyAlbumTitle] as? String, "Chapter 2")
        XCTAssertEqual(info[MPMediaItemPropertyPlaybackDuration] as? Double, 12.5)
        XCTAssertEqual(info[MPElapsedPlaybackTime] as? Double, 3.25)
        XCTAssertEqual(info[MPPlaybackRate] as? Double, 1.0)
        XCTAssertEqual(info[MPNowPlayingInfoPropertyChapterNumber] as? Int, 2)
        XCTAssertEqual(info[MPNowPlayingInfoPropertyChapterCount] as? Int, 5)
    }

    func testInfoAssemblyWithoutChaptersOrTimesStaysHonest() {
        let info = NowPlayingInfo.make(
            content: NowPlayingContent(title: "Test Book", chapterTitle: "One."),
            times: nil,
            playing: false
        )

        XCTAssertEqual(info[MPMediaItemPropertyTitle] as? String, "Test Book")
        XCTAssertEqual(info[MPMediaItemPropertyPlaybackDuration] as? Double, 0)
        XCTAssertEqual(info[MPElapsedPlaybackTime] as? Double, 0)
        XCTAssertEqual(info[MPPlaybackRate] as? Double, 0.0, "paused rate freezes the lock screen")
        XCTAssertNil(info[MPNowPlayingInfoPropertyChapterNumber])
        XCTAssertNil(info[MPNowPlayingInfoPropertyChapterCount])
    }

    func testCommandsRouteIntoTheTarget() {
        let rig = makeRig()

        registry.play.fire()
        registry.pause.fire()
        registry.nextTrack.fire()
        registry.previousTrack.fire()

        XCTAssertEqual(rig.target.calls, ["play", "pause", "next", "prev"])
    }

    func testToggleRoutesByTheTargetFact() {
        let rig = makeRig()

        rig.target.playing = false
        rig.registry.togglePlayPause.fire()
        XCTAssertEqual(rig.target.calls, ["play"])

        rig.target.playing = true
        rig.registry.togglePlayPause.fire()
        XCTAssertEqual(rig.target.calls, ["play", "pause"])
    }

    func testChangePlaybackPositionIsDisabled() {
        let rig = makeRig()

        XCTAssertFalse(
            rig.registry.changePlaybackPosition.isEnabled,
            "no seekbar — per-segment durations mislead (the locked design)"
        )
    }

    func testFactUpdatesPushTheAssembledDictionary() {
        let rig = makeRig()
        let controller = rig.controller

        controller.update(
            content: NowPlayingContent(
                title: "Test Book",
                chapterTitle: "Chapter 1",
                chapterNumber: 1,
                chapterCount: 3
            )
        )
        controller.update(times: SegmentTimes(duration: 8.0, elapsed: 2.0))
        controller.setPlaying(true)

        XCTAssertEqual(rig.sink.infos.count, 3, "one push per fact update")
        let last = rig.sink.infos.last
        XCTAssertEqual(last?[MPMediaItemPropertyTitle] as? String, "Test Book")
        XCTAssertEqual(last?[MPElapsedPlaybackTime] as? Double, 2.0)
        XCTAssertEqual(last?[MPPlaybackRate] as? Double, 1.0)
    }
}
