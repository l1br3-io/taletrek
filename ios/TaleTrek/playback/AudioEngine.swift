import AVFoundation

/// The audio engine as the bridge commands it — the AVAudioEngine-backed
/// port in production, a recorder in tests. Mirrors the desktop's
/// `AudioTransport` seam and Android's `AudioPort`: commands out
/// (`playSegment`/`stopOutput`), platform reports in through the sink.
protocol AudioPort: AnyObject {
    /// Read + decode the segment keyed `key` from the open bundle, then
    /// schedule its PCM `offset` seconds in. Readiness, drains, and
    /// failures report back through the attached sink.
    func playSegment(key: String, offset: Double)

    /// Silence output and drop the current segment.
    func stopOutput()

    /// The armed segment's Now Playing currency — honest duration from
    /// decoded PCM + audio-time elapsed; `nil` when nothing is armed.
    /// Lock-screen facts only, sequencing never reads it.
    func nowPlayingTimes() -> SegmentTimes?
}

extension AudioPort {
    func nowPlayingTimes() -> SegmentTimes? { nil }
}

/// The current segment's Now Playing facts: full duration (decoded
/// PCM length over rate) and elapsed audio time (scheduled offset +
/// frames played). One honest currency — no extrapolated book time.
struct SegmentTimes: Equatable {
    let duration: Double
    let elapsed: Double
}

/// The engine's reports to the bridge. Every callback hops through the
/// engine's serialization queue before landing on the main actor — the
/// bridge observes a totally ordered stream (the desktop's
/// sole-event-sender invariant, queue-shaped).
protocol EngineEventSink: AnyObject {
    /// The playhead for `key` is armed — the bridge's pending window
    /// closes on this.
    func onReady(key: String)

    /// The segment keyed `key` played to its end.
    func onSegmentDrained(key: String)

    /// The platform could not read or decode the segment keyed `key` —
    /// the kernel's skip path, never a crash.
    func onSegmentFailed(key: String, error: String)
}

/// One segment's decode, injectable for tests: `decodeSegment` in
/// production, a scripted stand-in otherwise.
typealias SegmentDecoder = (_ path: String, _ key: String) throws -> FfiDecodedAudio?

/// The AVFoundation half of the platform contract: one shared
/// `AVAudioPlayerNode` fed by the kernel's ordered loads, decode in the
/// kernel (AVFoundation has no OGG/Opus decoder — `decodeSegment` is the
/// single hop), output at the PCM's native rate with `mainMixer`
/// performing any rate conversion (the desktop's no-resample stance).
///
/// # Ordering: generation epochs
///
/// Node completion handlers fire on an AVAudioEngine-internal thread the
/// bridge cannot intercept, so a stale completion for a superseded load
/// must be dropped *here* before it ever hops to main. Every port
/// command bumps a generation; each scheduled buffer's completion
/// captures the generation it was scheduled under and is silently
/// discarded when the engine has since moved on (`node.stop()` fires
/// orphaned handlers — that is the race source, and this is its closure).
/// With the pending window in `PlayerBridge` (which catches emissions
/// that left the engine before a command landed) and the kernel's
/// defensive machine beneath both, a stale drain for a re-loaded
/// identical segment is unrepresentable rather than merely unlikely.
///
/// # The not-ready hold (progressive books)
///
/// A filling book's decoder throws [`SegmentNotReady`] for segments the
/// live job has not landed yet. The engine holds the load —
/// re-attempting off the queue (`asyncAfter`, so port commands stay
/// serviced) at a fixed cadence while `mayStillLand` says a job could
/// still land it — then reports the **typed** not-ready failure (the
/// bridge's resume affordance; never the kernel's skip). Generation
/// checks every hop make a superseded hold vanish silently.
final class AudioEngine: AudioPort {
    private let path: String
    private let decoder: SegmentDecoder

    /// Whether a synth job that could still land a not-ready segment is
    /// running — the not-ready hold's liveness seam (production: the
    /// convert controller's running phase).
    private let mayStillLand: () -> Bool

    /// The not-ready re-attempt cadence.
    private let holdInterval: TimeInterval = 0.25

    /// Serializes decode, graph edits, scheduling, and every callback
    /// emission — the engine's sole-sender discipline.
    private let queue = DispatchQueue(label: "dev.l1br3.taletrek.audio-engine")
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private weak var sink: EngineEventSink?

    /// Bumped on every port command; completions carry the generation
    /// they were scheduled under (see the ordering note above).
    private var generation = 0
    private var connectedFormat: AVAudioFormat?

    /// The armed segment's Now Playing facts source (nil when idle or
    /// stopped — the lock screen then keeps the last pushed elapsed).
    private var scheduled: (duration: Double, offset: Double, sampleRate: Double)?

    /// The walk test's probe: the segments the engine was told to play,
    /// in order, with their scheduled offsets.
    private var appliedLoads: [(key: String, offset: Double)] = []

    init(
        path: String,
        decoder: @escaping SegmentDecoder,
        mayStillLand: @escaping () -> Bool = { false }
    ) {
        self.path = path
        self.decoder = decoder
        self.mayStillLand = mayStillLand
        engine.attach(node)
    }

    /// Convenience initializer over the kernel's batch decode hop (the
    /// sealed-bundle shape the walk tests and fresh-run prove).
    convenience init(path: String) {
        self.init(path: path) { bundlePath, key in
            try decodeSegment(path: bundlePath, key: key)
        }
    }

    /// Convenience initializer over the progressive source
    /// (store-aware read + bytes decode + the not-ready hold) — the
    /// production wiring; `jobAlive` is the hold's liveness seam.
    convenience init(path: String, jobAlive: @escaping () -> Bool) {
        let source = ProgressiveSegmentSource()
        self.init(path: path, decoder: { bundlePath, key in
            try source.decoder(path: bundlePath, key: key)
        }, mayStillLand: jobAlive)
    }

    /// Wire the bridge this engine reports into (constructed before the
    /// bridge owns it, attached right after).
    func attach(_ sink: EngineEventSink) {
        self.sink = sink
    }

    func playSegment(key: String, offset: Double) {
        queue.async { [weak self] in
            guard let self else { return }
            self.generation &+= 1
            let gen = self.generation
            self.attemptLoad(key: key, offset: offset, generation: gen)
        }
    }

    /// One decode attempt (queue-only). A not-ready segment re-arms
    /// itself off the queue (`asyncAfter` keeps commands serviced);
    /// generation checks every hop make a superseded hold vanish.
    private func attemptLoad(key: String, offset: Double, generation gen: Int) {
        guard gen == generation else { return }
        do {
            guard let audio = try self.decoder(self.path, key) else {
                self.deliver(.failed(key: key, error: "segment missing from bundle"), gen)
                return
            }
            guard gen == generation else { return }
            try self.schedule(audio: audio, key: key, offset: offset, generation: gen)
            self.appliedLoads.append((key: key, offset: offset))
            self.deliver(.ready(key: key), gen)
        } catch let notReady as SegmentNotReady {
            if mayStillLand() {
                queue.asyncAfter(deadline: .now() + holdInterval) { [weak self] in
                    self?.attemptLoad(key: key, offset: offset, generation: gen)
                }
            } else {
                // The typed not-ready — the bridge's resume affordance,
                // never the kernel's skip.
                self.deliver(.failed(key: key, error: SegmentNotReady.errorMarker), gen)
            }
        } catch {
            self.deliver(.failed(key: key, error: "\(error)"), gen)
        }
    }

    func stopOutput() {
        queue.async { [weak self] in
            guard let self else { return }
            // Orphans any in-flight decode and pending completion
            // handlers (they fire on `stop()` — the epoch drops them).
            self.generation &+= 1
            self.scheduled = nil
            self.node.stop()
        }
    }

    func nowPlayingTimes() -> SegmentTimes? {
        queue.sync {
            guard let armed = scheduled else { return nil }
            let played: Double = {
                guard
                    node.isPlaying,
                    let render = node.lastRenderTime,
                    let player = node.playerTime(forNodeTime: render)
                else { return 0 }
                return max(Double(player.sampleTime) / armed.sampleRate, 0)
            }()
            return SegmentTimes(
                duration: armed.duration,
                elapsed: min(armed.offset + played, armed.duration)
            )
        }
    }

    /// Whether the engine is running — the no-teardown probe (criterion:
    /// the engine outlives transitions; only the node ever stops).
    var isEngineRunning: Bool {
        queue.sync { engine.isRunning }
    }

    /// The segments played so far, `(key, offset)` in order (the tests'
    /// probe).
    var loadedSegments: [(key: String, offset: Double)] {
        queue.sync { appliedLoads }
    }

    // --- scheduling (queue only) -------------------------------------------

    private enum Report {
        case ready(key: String)
        case drained(key: String)
        case failed(key: String, error: String)
    }

    /// Decode-then-schedule one segment: stop the node (dropping any
    /// in-flight buffer), (re)connect for the PCM's native format when
    /// it changed, arm the completion, and start.
    private func schedule(
        audio: FfiDecodedAudio, key: String, offset: Double, generation gen: Int
    ) throws {
        node.stop()
        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: Double(audio.sampleRate),
                channels: AVAudioChannelCount(audio.channels),
                interleaved: false
            )
        else {
            throw PlaybackSetupError.format(rate: audio.sampleRate, channels: audio.channels)
        }
        if connectedFormat != format {
            engine.disconnectNodeOutput(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)
            connectedFormat = format
        }
        if !engine.isRunning {
            try engine.start()
        }
        let channels = Int(audio.channels)
        let totalFrames = audio.samples.count / max(channels, 1)
        scheduled = (
            duration: Double(totalFrames) / Double(audio.sampleRate),
            offset: offset,
            sampleRate: Double(audio.sampleRate)
        )
        node.scheduleBuffer(
            makeBuffer(audio: audio, format: format, offset: offset),
            completionCallbackType: .dataPlayedBack
        ) { [weak self] _ in
            guard let self else { return }
            self.queue.async {
                guard gen == self.generation else { return }
                self.deliver(.drained(key: key), gen)
            }
        }
        node.play()
    }

    /// Interleave the kernel's i16 PCM into a Float32 buffer, trimmed to
    /// start `offset` seconds in (frame-aligned).
    private func makeBuffer(
        audio: FfiDecodedAudio, format: AVAudioFormat, offset: Double
    ) -> AVAudioPCMBuffer {
        let channels = Int(audio.channels)
        let totalFrames = audio.samples.count / max(channels, 1)
        let startFrame = min(Int(offset * Double(audio.sampleRate)), max(totalFrames - 1, 0))
        let frames = AVAudioFrameCount(totalFrames - startFrame)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        guard let data = buffer.floatChannelData else { return buffer }
        let base = startFrame * channels
        if channels == 1 {
            for frame in 0 ..< Int(frames) {
                data[0][frame] = Float(audio.samples[base + frame]) / 32768.0
            }
        } else {
            for frame in 0 ..< Int(frames) {
                for channel in 0 ..< channels {
                    data[channel][frame] =
                        Float(audio.samples[base + frame * channels + channel]) / 32768.0
                }
            }
        }
        return buffer
    }

    /// Epoch-checked handoff onto the main actor (FIFO: emissions are
    /// enqueued in queue order).
    private func deliver(_ report: Report, _ gen: Int) {
        guard gen == generation else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let sink = self.sink else { return }
            switch report {
            case let .ready(key):
                sink.onReady(key: key)
            case let .drained(key):
                sink.onSegmentDrained(key: key)
            case let .failed(key, error):
                sink.onSegmentFailed(key: key, error: error)
            }
        }
    }
}

/// A scheduling precondition the platform refused (format) — one
/// sentence, no AVFoundation types leak.
struct PlaybackSetupError: Error, CustomStringConvertible {
    let description: String

    static func format(rate: UInt32, channels: UInt8) -> Self {
        Self(description: "cannot build PCM format for \(channels)-channel \(rate) Hz audio")
    }
}
