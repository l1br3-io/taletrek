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
