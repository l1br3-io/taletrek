import Foundation

/// The only place AVFoundation and the kernel meet — the platform
/// contract verbatim: audio time arrives here as engine reports,
/// sequencing decisions leave here as kernel events, and this class
/// contains no next/prev/boundary logic of its own. Every decision is a
/// `TrekPlayer` transition; the bridge executes what the kernel orders
/// and nothing more.
///
/// # The same-key re-load race (the closure, three layers)
///
/// Duplicate-text paragraphs share segment keys, so a stale completion
/// for the paragraph the engine *was* on can arrive right after the
/// machine re-loaded identical content — and the kernel's key check
/// cannot tell it apart from the real drain. The closure is layered so
/// a stale drain is unrepresentable rather than merely unlikely
/// (desktop doctrine, `playback.rs`'s invariant note):
///
/// 1. **Engine generations** (`AudioEngine`): every port command bumps
///    an epoch; completions capture the epoch they were scheduled under
///    and are dropped inside the engine when it has since moved on.
///    Catches emissions racing a command that already executed.
/// 2. **The pending window** (this bridge): while a load is
///    outstanding, drains are dropped; the engine's *ready* ack —
///    emitted only after the new playhead is armed, FIFO-ordered onto
///    the main actor through the engine's serialization queue — ends
///    the window. A drain observed after the ack can only belong to the
///    new load. Catches emissions that left the engine *before* the
///    command executed but landed after it was issued.
/// 3. **The kernel's defensive machine**: drains naming a foreign key
///    and completions while Paused/Idle are absorbed by the state
///    machine itself — total, never a double-advance.
@MainActor
final class PlayerBridge {
    private let kernel: TrekPlayer
    private let port: AudioPort
    private let session: PlaybackSession

    /// The key of the outstanding load, until its ready/failure report
    /// (layer 2 of the closure above).
    private var pendingKey: String?

    /// The last durable position reported to `onPositionChanged` — the
    /// save cadence's dedup (Android's shape: the kernel's position
    /// moves only on transport events, so dedup is the debounce).
    private var lastReportedPosition: FfiPosition?

    /// Snapshot changes, pushed after every executed transition — the
    /// reader's HUD and highlight ride this. Set by the view model.
    var onSnapshotChanged: ((FfiStateSnapshot) -> Void)?

    /// Durable-position changes, deduped — one report per actual move.
    var onPositionChanged: ((FfiPosition?) -> Void)?

    init(kernel: TrekPlayer, port: AudioPort, session: PlaybackSession = AudioSession()) {
        self.kernel = kernel
        self.port = port
        self.session = session
    }

    // --- user transport (buttons, remote commands — task 006) -----------

    func userPlay() {
        dispatch(.play)
    }

    func userPause() {
        dispatch(.pause)
    }

    func userNextParagraph() {
        dispatch(.nextParagraph)
    }

    func userPrevParagraph() {
        dispatch(.prevParagraph)
    }

    func userNextChapter() {
        dispatch(.nextChapter)
    }

    func userPrevChapter() {
        dispatch(.prevChapter)
    }

    func userSeekToParagraph(chapter: UInt32, index: UInt32) {
        dispatch(.seekToParagraph(pos: FfiParagraphPos(chapter: chapter, index: index)))
    }

    func userSeekWithinParagraph(offset: Double) {
        dispatch(.seekWithinParagraph(offset: offset))
    }

    // --- observation ------------------------------------------------------

    /// The renderable state right now (the reader's HUD rides this).
    var snapshot: FfiStateSnapshot {
        kernel.stateSnapshot()
    }

    /// The durable position right now — `nil` at idle.
    var position: FfiPosition? {
        kernel.position()
    }

    /// The Now Playing currency straight from the engine — the armed
    /// segment's duration + audio-time elapsed, `nil` when nothing is
    /// armed. Render facts; the lock screen is their only consumer.
    var nowPlayingTimes: SegmentTimes? {
        port.nowPlayingTimes()
    }

    // --- engine reports in (the sink side) --------------------------------

    private func dispatch(_ event: FfiPlayerEvent) {
        execute(kernel.tick(event: event))
        reportPosition()
        onSnapshotChanged?(kernel.stateSnapshot())
    }

    private func reportPosition() {
        guard let onPositionChanged else { return }
        let pos = kernel.position()
        guard pos != lastReportedPosition else { return }
        lastReportedPosition = pos
        onPositionChanged(pos)
    }

    private func execute(_ action: FfiPlayerAction) {
        switch action {
        case let .loadSegment(key, offset):
            pendingKey = key
            do {
                try session.activateForPlayback()
            } catch {
                pendingKey = nil
                dispatch(.segmentFailed(key: key, error: "\(error)"))
                return
            }
            port.playSegment(key: key, offset: offset)
        case .stop:
            pendingKey = nil
            port.stopOutput()
        case .none:
            break // total switch — no default silencing
        }
    }
}

extension PlayerBridge: EngineEventSink {
    func onReady(key: String) {
        pendingKey = nil
    }

    func onSegmentDrained(key: String) {
        guard pendingKey == nil else { return } // pre-load stale — dropped
        dispatch(.segmentDrained(key: key))
    }

    func onSegmentFailed(key: String, error: String) {
        pendingKey = nil
        dispatch(.segmentFailed(key: key, error: error))
    }
}

/// The lock screen may command the bridge exactly as the transport bar
/// does — the same user events, the kernel's same transitions (a
/// remote chapter press is indistinguishable from an in-app tap, the
/// task-006 criterion).
extension PlayerBridge: RemoteCommandTarget {
    var isPlaying: Bool {
        snapshot.status == .playing
    }

    func play() {
        userPlay()
    }

    func pause() {
        userPause()
    }

    func nextChapter() {
        userNextChapter()
    }

    func prevChapter() {
        userPrevChapter()
    }
}
