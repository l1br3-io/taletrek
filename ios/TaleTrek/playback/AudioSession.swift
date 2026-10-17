import AVFoundation

/// The app's audio-session policy — the platform's permission slip for
/// the Jog bar: `.playback` from the first play, never torn down. The
/// session outlives background/foreground transitions within the host
/// (task 004's criterion); the background-audio entitlement that makes
/// the lock screen keep it alive is task 006's to declare.
protocol PlaybackSession: AnyObject {
    /// Activate the session for playback — idempotent; a no-op once
    /// active. Throws so a session failure rides the kernel's
    /// segment-skip path like every other platform load failure.
    func activateForPlayback() throws
}

/// The production session over `AVAudioSession`.
final class AudioSession: PlaybackSession {
    private let session = AVAudioSession.sharedInstance()
    private var activated = false

    func activateForPlayback() throws {
        guard !activated else { return }
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        activated = true
    }
}

/// An audio-session interruption's shape — the pause/resume facts the
/// platform reports (AVAudioSession numerics stay inside the system
/// source).
enum AudioInterruption: Equatable {
    case began
    case ended(shouldResume: Bool)
}

/// Where interruptions come from — AVAudioSession's notification in
/// production, the test's hands otherwise.
protocol InterruptionSource: AnyObject {
    func observe(_ handler: @escaping (AudioInterruption) -> Void)
}

/// The production source over `AVAudioSession.interruptionNotification`
/// (a call, Siri, an alarm). Delivered on main — the notification is
/// registered with a main queue.
final class SystemInterruptionSource: InterruptionSource {
    private var observer: (any NSObjectProtocol)?

    func observe(_ handler: @escaping (AudioInterruption) -> Void) {
        observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { note in
            let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
            if type == AVAudioSession.InterruptionType.began.rawValue {
                handler(.began)
            } else if type == AVAudioSession.InterruptionType.ended.rawValue {
                let shouldResume = AVAudioSession.InterruptionOptions(
                    rawValue: options ?? 0
                ).contains(.shouldResume)
                handler(.ended(shouldResume: shouldResume))
            }
        }
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}

/// A route change the guard acts on — only the unplug fact. Re-plug
/// (`.newDeviceUnavailable`) is deliberately unmapped: no auto-resume
/// (the user's call; the focus-loss policy's stance verbatim).
enum AudioRouteChange: Equatable {
    case oldDeviceUnavailable
}

/// Where route changes come from — AVAudioSession's notification in
/// production, the test's hands otherwise. The observe/stop pair is the
/// playing gate's surface: the guard registers on play and tears the
/// observation down on every non-playing path.
protocol RouteChangeSource: AnyObject {
    func observe(_ handler: @escaping (AudioRouteChange) -> Void)
    func stopObserving()
}

/// The production source over `AVAudioSession.routeChangeNotification`
/// — old-device-gone is the unplug (headphones pulled, Bluetooth
/// dropped). Delivered on main, like the interruption source.
final class SystemRouteChangeSource: RouteChangeSource {
    private var observer: (any NSObjectProtocol)?

    func observe(_ handler: @escaping (AudioRouteChange) -> Void) {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { note in
            let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                handler(.oldDeviceUnavailable)
            }
        }
    }

    func stopObserving() {
        guard let observer else { return }
        NotificationCenter.default.removeObserver(observer)
        self.observer = nil
    }

    deinit {
        stopObserving()
    }
}

/// The unplug-pause guard (android-hardening parity): headphones pulled
/// mid-book pauses through the kernel — one `userPause`, the same
/// transition as the pause button — never an engine-side pause, never
/// an auto-resume on re-plug. The observation is playing-gated: armed
/// when playback starts, torn down on every non-playing path (pause,
/// stop, drain-end, idle), so a route change can never fire at a
/// reader that isn't listening and no observer outlives its window.
@MainActor
final class RouteChangeGuard {
    private let pause: () -> Void
    private let source: RouteChangeSource
    private var armed = false

    init(pause: @escaping () -> Void, source: RouteChangeSource) {
        self.pause = pause
        self.source = source
    }

    /// The render fact that gates the observation — call on every
    /// status change, the same cadence as the lock screen's own.
    func setPlaying(_ playing: Bool) {
        if playing, !armed {
            armed = true
            source.observe { [weak self] _ in
                Task { @MainActor in self?.unplugged() }
            }
        } else if !playing, armed {
            armed = false
            source.stopObserving()
        }
    }

    deinit {
        if armed {
            source.stopObserving()
        }
    }

    private func unplugged() {
        guard armed else { return } // a hop that outlived teardown — dropped
        pause()
    }
}
