import Foundation
import MediaPlayer

/// The lock screen's model of the book — everything Now Playing
/// renders, nothing it can command (that table is the target protocol
/// below). Honest kernel currency only: chapter ordinal + count, no
/// durations-beyond-the-segment.
struct NowPlayingContent: Equatable {
    var title = ""
    var chapterTitle = ""
    /// 1-based chapter ordinal (the "Chapter n of N" currency).
    var chapterNumber = 0
    var chapterCount = 0
}

/// What the lock screen may command — the locked chapter granularity
/// (Android's notification set verbatim): play/pause/toggle +
/// prev/next chapter. `isPlaying` is a render fact the toggle routes
/// by; every sequencing decision stays kernel-side.
protocol RemoteCommandTarget: AnyObject {
    var isPlaying: Bool { get }
    func play()
    func pause()
    func nextChapter()
    func prevChapter()
}

/// One registrable remote command — the system fires it in production,
/// the test does by hand.
protocol RemoteCommand: AnyObject {
    var isEnabled: Bool { get set }
    func setHandler(_ handler: @escaping () -> Void)
}

/// The five commands the granularity allows, plus the one it forbids.
protocol RemoteCommandRegistry: AnyObject {
    var play: RemoteCommand { get }
    var pause: RemoteCommand { get }
    var togglePlayPause: RemoteCommand { get }
    var nextTrack: RemoteCommand { get }
    var previousTrack: RemoteCommand { get }
    var changePlaybackPosition: RemoteCommand { get }
}

/// Assembles the Now Playing info dictionary — pure, the test surface.
/// Elapsed is monotonic per segment; the system extrapolates between
/// pushes via the rate, so no timer needs to survive backgrounding.
enum NowPlayingInfo {
    static func make(
        content: NowPlayingContent,
        times: SegmentTimes?,
        playing: Bool
    ) -> [String: Any] {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: content.title,
            MPMediaItemPropertyAlbumTitle: content.chapterTitle,
            MPMediaItemPropertyPlaybackDuration: times?.duration ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: times?.elapsed ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
        if content.chapterCount > 0 {
            info[MPNowPlayingInfoPropertyChapterNumber] = content.chapterNumber
            info[MPNowPlayingInfoPropertyChapterCount] = content.chapterCount
        }
        return info
    }
}

/// Where assembled info lands — `MPNowPlayingInfoCenter` in production,
/// a recorder in tests.
protocol NowPlayingInfoSink: AnyObject {
    func setInfo(_ info: [String: Any])
}

/// The lock screen's half of the platform contract: renders info from
/// render facts, forwards the locked command set into the target —
/// never decides sequence. Any fact update re-pushes the whole
/// dictionary (the system replaces, it does not merge).
final class NowPlayingController {
    private let target: RemoteCommandTarget
    private let infoSink: NowPlayingInfoSink
    private let registry: RemoteCommandRegistry

    private var content = NowPlayingContent()
    private var times: SegmentTimes?
    private var playing = false

    init(
        target: RemoteCommandTarget,
        infoSink: NowPlayingInfoSink,
        registry: RemoteCommandRegistry
    ) {
        self.target = target
        self.infoSink = infoSink
        self.registry = registry
        registerCommands()
    }

    func update(content: NowPlayingContent) {
        self.content = content
        push()
    }

    func update(times: SegmentTimes) {
        self.times = times
        push()
    }

    func setPlaying(_ playing: Bool) {
        self.playing = playing
        push()
    }

    private func push() {
        infoSink.setInfo(
            NowPlayingInfo.make(content: content, times: times, playing: playing)
        )
    }

    private func registerCommands() {
        registry.play.setHandler { [weak target] in target?.play() }
        registry.pause.setHandler { [weak target] in target?.pause() }
        // The toggle routes by the target's own render fact — the one
        // mapping this side is allowed to make (headphones' single
        // button; the kernel still decides what play/pause means).
        registry.togglePlayPause.setHandler { [weak target] in
            guard let target else { return }
            if target.isPlaying {
                target.pause()
            } else {
                target.play()
            }
        }
        registry.nextTrack.setHandler { [weak target] in target?.nextChapter() }
        registry.previousTrack.setHandler { [weak target] in target?.prevChapter() }
        // No seekbar: per-segment durations mislead (the locked design).
        registry.changePlaybackPosition.isEnabled = false
    }
}

/// The production boxes — MediaPlayer behind the seams.

final class MediaNowPlayingSink: NowPlayingInfoSink {
    func setInfo(_ info: [String: Any]) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

/// One `MPRemoteCommand` boxed — the main hop lives here so the fakes
/// (and therefore the tests) stay synchronous. MediaPlayer does not
/// promise a thread for handlers.
final class SystemRemoteCommand: RemoteCommand {
    private let command: MPRemoteCommand

    init(_ command: MPRemoteCommand) {
        self.command = command
    }

    var isEnabled: Bool {
        get { command.isEnabled }
        set { command.isEnabled = newValue }
    }

    func setHandler(_ handler: @escaping () -> Void) {
        command.addTarget { _ in
            DispatchQueue.main.async(execute: handler)
            return .success
        }
    }
}

final class MediaRemoteRegistry: RemoteCommandRegistry {
    private let center = MPRemoteCommandCenter.shared()

    let play: RemoteCommand
    let pause: RemoteCommand
    let togglePlayPause: RemoteCommand
    let nextTrack: RemoteCommand
    let previousTrack: RemoteCommand
    let changePlaybackPosition: RemoteCommand

    init() {
        play = SystemRemoteCommand(center.playCommand)
        pause = SystemRemoteCommand(center.pauseCommand)
        togglePlayPause = SystemRemoteCommand(center.togglePlayPauseCommand)
        nextTrack = SystemRemoteCommand(center.nextTrackCommand)
        previousTrack = SystemRemoteCommand(center.previousTrackCommand)
        changePlaybackPosition = SystemRemoteCommand(center.changePlaybackPositionCommand)
    }
}
