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
final class AudioEngine: AudioPort {
    private let path: String
    private let decoder: SegmentDecoder

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

    /// The walk test's probe: the segments the engine was told to play,
    /// in order, with their scheduled offsets.
    private var appliedLoads: [(key: String, offset: Double)] = []

    init(path: String, decoder: @escaping SegmentDecoder) {
        self.path = path
        self.decoder = decoder
        engine.attach(node)
    }

    /// Convenience initializer over the kernel's real decode hop.
    convenience init(path: String) {
        self.init(path: path) { bundlePath, key in
            try decodeSegment(path: bundlePath, key: key)
        }
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
            do {
                guard let audio = try self.decoder(self.path, key) else {
                    self.deliver(.failed(key: key, error: "segment missing from bundle"), gen)
                    return
                }
                guard gen == self.generation else { return }
                try self.schedule(audio: audio, key: key, offset: offset, generation: gen)
                self.appliedLoads.append((key: key, offset: offset))
                self.deliver(.ready(key: key), gen)
            } catch {
                self.deliver(.failed(key: key, error: "\(error)"), gen)
            }
        }
    }

    func stopOutput() {
        queue.async { [weak self] in
            guard let self else { return }
            // Orphans any in-flight decode and pending completion
            // handlers (they fire on `stop()` — the epoch drops them).
            self.generation &+= 1
            self.node.stop()
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
