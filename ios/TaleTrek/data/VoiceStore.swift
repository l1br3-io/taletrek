import Combine
import Foundation

/// The selected voice, iOS backend: one file in Application Support
/// holding the raw id string (absent file = nil = the kernel default) —
/// the platform-side selection store, mirroring the position store's
/// shape (one file, one active handle, constructor-injected for tests).
/// The kernel stays stateless about which voice is "current"; it just
/// receives the id per job.
@MainActor
final class VoiceStore: ObservableObject {
    @Published private(set) var selected: String?

    /// The production store: `Application Support/voice-selection`.
    static let standard = VoiceStore(fileURL: VoiceStore.standardFileURL)

    static var standardFileURL: URL {
        HostDirs.supportRoot.appendingPathComponent("voice-selection")
    }

    private let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
        selected = Self.read(from: fileURL)
    }

    /// Select `voiceId`, or pass `nil` to return to the kernel default.
    func setSelected(_ voiceId: String?) {
        selected = voiceId
        persist()
    }

    private func persist() {
        guard let selected else {
            try? FileManager.default.removeItem(at: fileURL)
            return
        }
        try? Data(selected.utf8).write(to: fileURL, options: .atomic)
    }

    /// The tolerant read: an absent or unreadable file is "no override"
    /// (the kernel default), never a crash.
    private static func read(from url: URL) -> String? {
        guard
            let data = try? Data(contentsOf: url),
            let id = String(data: data, encoding: .utf8),
            !id.isEmpty
        else {
            return nil
        }
        return id
    }
}
