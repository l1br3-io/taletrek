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
