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
        let playCmd = FakeCommand()
        let pauseCmd = FakeCommand()
        let toggleCmd = FakeCommand()
        let nextCmd = FakeCommand()
        let prevCmd = FakeCommand()
        let seekCmd = FakeCommand()

        // Stored witnesses must match the protocol type exactly;
        // computed getters may return subtypes.
        var play: RemoteCommand { playCmd }
        var pause: RemoteCommand { pauseCmd }
        var togglePlayPause: RemoteCommand { toggleCmd }
        var nextTrack: RemoteCommand { nextCmd }
        var previousTrack: RemoteCommand { prevCmd }
        var changePlaybackPosition: RemoteCommand { seekCmd }
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
        XCTAssertEqual(info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double, 3.25)
        XCTAssertEqual(info[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 1.0)
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
        XCTAssertEqual(info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double, 0)
        XCTAssertEqual(info[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 0.0, "paused rate freezes the lock screen")
        XCTAssertNil(info[MPNowPlayingInfoPropertyChapterNumber])
        XCTAssertNil(info[MPNowPlayingInfoPropertyChapterCount])
    }

    func testCommandsRouteIntoTheTarget() {
        let rig = makeRig()

        rig.registry.playCmd.fire()
        rig.registry.pauseCmd.fire()
        rig.registry.nextCmd.fire()
        rig.registry.prevCmd.fire()

        XCTAssertEqual(rig.target.calls, ["play", "pause", "next", "prev"])
    }

    func testToggleRoutesByTheTargetFact() {
        let rig = makeRig()

        rig.target.playing = false
        rig.registry.toggleCmd.fire()
        XCTAssertEqual(rig.target.calls, ["play"])

        rig.target.playing = true
        rig.registry.toggleCmd.fire()
        XCTAssertEqual(rig.target.calls, ["play", "pause"])
    }

    func testChangePlaybackPositionIsDisabled() {
        let rig = makeRig()

        XCTAssertFalse(
            rig.registry.seekCmd.isEnabled,
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
        XCTAssertEqual(last?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double, 2.0)
        XCTAssertEqual(last?[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 1.0)
    }
}

/// The unplug guard's hostable half: playing-gated observation over a
/// faked source and the pause routing (the real AVAudioSession
/// notification stays production-only). The JVM-analog discipline:
/// observer lifecycle proven without hardware.
@MainActor
final class RouteChangeGuardTests: XCTestCase {
    private final class FakeRouteSource: RouteChangeSource {
        private(set) var observes = 0
        private(set) var stops = 0
        private var handler: ((AudioRouteChange) -> Void)?

        func observe(_ handler: @escaping (AudioRouteChange) -> Void) {
            observes += 1
            self.handler = handler
        }

        func stopObserving() {
            stops += 1
            handler = nil
        }

        /// Fires like the main-queue notification would — the guard's
        /// handler hops to the main actor, so effects land after a run
        /// loop turn.
        func fireUnplug() {
            handler?(.oldDeviceUnavailable)
        }
    }

    func testUnplugPausesThroughTheSeamWhilePlaying() {
        let source = FakeRouteSource()
        var pauses = 0
        let routeGuard = RouteChangeGuard(pause: { pauses += 1 }, source: source)

        routeGuard.setPlaying(true)
        source.fireUnplug()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        XCTAssertEqual(pauses, 1, "one userPause — through the kernel seam")
    }

    func testTheObservationIsPlayingGated() {
        let source = FakeRouteSource()
        var pauses = 0
        let routeGuard = RouteChangeGuard(pause: { pauses += 1 }, source: source)

        XCTAssertEqual(source.observes, 0, "never registered before playback")
        source.fireUnplug()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(pauses, 0)

        routeGuard.setPlaying(true)
        XCTAssertEqual(source.observes, 1, "armed on play")

        routeGuard.setPlaying(false)
        XCTAssertEqual(source.stops, 1, "torn down on the non-playing path")
        source.fireUnplug()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(pauses, 0, "a torn-down observation cannot pause")

        routeGuard.setPlaying(true)
        XCTAssertEqual(source.observes, 2, "re-armed on the next play window")
    }

    func testRepeatedStatesNeitherDoubleArmNorDoubleStop() {
        let source = FakeRouteSource()
        let routeGuard = RouteChangeGuard(pause: {}, source: source)

        routeGuard.setPlaying(true)
        routeGuard.setPlaying(true)
        routeGuard.setPlaying(true)
        XCTAssertEqual(source.observes, 1)

        routeGuard.setPlaying(false)
        routeGuard.setPlaying(false)
        XCTAssertEqual(source.stops, 1)
    }

    func testAHopThatOutlivedTeardownIsDropped() {
        let source = FakeRouteSource()
        var pauses = 0
        let routeGuard = RouteChangeGuard(pause: { pauses += 1 }, source: source)

        routeGuard.setPlaying(true)
        source.fireUnplug()
        // Teardown lands before the fired hop runs — the stale hop must
        // find the gate closed.
        routeGuard.setPlaying(false)
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        XCTAssertEqual(pauses, 0, "no pause from a notification the gate already rejected")
    }
}
