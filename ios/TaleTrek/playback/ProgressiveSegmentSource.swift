import Foundation

/// The typed not-ready exhaustion: the book is filling but no live job
/// will land the segment (job dead + still `notReady`). The engine
/// reports the [`errorMarker`] string for it; the bridge routes that to
/// the resume affordance — never the kernel's skip path.
struct SegmentNotReady: Error, Equatable {
    let key: String

    /// The wire marker the engine's failure report carries (errors
    /// cross the sink as strings; the marker is unambiguous).
    static let errorMarker = "taletrek:segment-not-ready"
}

/// The progressive read+decode hop, single-shot — the production
/// `SegmentDecoder` for every book. `read_segment_progressive` decides
/// readiness (a landed store segment upgrades a text-only bundle's
/// answer to `ready`), the bytes decode through the kernel's bytes hop,
/// `missing` returns nil (the honest skip the kernel's fail-path owns),
/// and `notReady` throws [`SegmentNotReady`] **immediately** — the
/// engine owns the retry cadence (its generation checks keep the wait
/// off the queue and supersede-aware; its `mayStillLand` seam ends the
/// wait when the job dies).
final class ProgressiveSegmentSource {
    init() {}

    func decoder(path: String, key: String) throws -> FfiDecodedAudio? {
        switch try readSegmentProgressive(path: path, key: key) {
        case let .ready(bytes, _):
            return try decodeSegmentBytes(bytes: bytes)
        case .missing:
            return nil
        case .notReady:
            throw SegmentNotReady(key: key)
        }
    }
}
