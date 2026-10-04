import Foundation

/// One durable reading position as it persists — the kernel's three
/// fields, stored under the kernel's own `positionStorageKey(bookId)`
/// string (one keying, no drift; a moved file and a re-voiced bundle
/// keep the place by construction).
struct StoredPosition: Equatable {
    var chapter: UInt32
    var index: UInt32
    var offset: Double

    init(chapter: UInt32, index: UInt32, offset: Double) {
        self.chapter = chapter
        self.index = index
        self.offset = offset
    }

    init(_ position: FfiPosition) {
        chapter = position.chapter
        index = position.index
        offset = position.offset
    }

    var asFfi: FfiPosition {
        FfiPosition(chapter: chapter, index: index, offset: offset)
    }
}

/// The position half of the platform contract, iOS backend: one JSON
/// file in Application Support, `[storageKey: {chapter, index, offset}]`
/// (the plan's call — a single inspectable file over UserDefaults).
///
/// Tolerance follows the Android store's rule: a position is one fact,
/// never a half-position — any missing or wrong-typed field reads the
/// whole entry as absent, and a corrupt file reads as empty (fresh
/// state; the next save rewrites it whole). Reads/writes serialize on
/// the caller's expectation of main-actor use; the file itself is small
/// and atomic-written.
final class PositionStore {
    /// `[storageKey: {"chapter": n, "index": n, "offset": x}]`.
    private var entries: [String: [String: Any]]
    private let fileURL: URL

    /// The production store: `Application Support/positions.json`
    /// (lazily initialized on first access — the UI-test reset hook
    /// removes the file before anything reads it).
    static let standard = PositionStore(fileURL: PositionStore.standardFileURL)

    /// Where the production store lives (the reset hook's target).
    static var standardFileURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("positions.json")
    }

    /// Remove the production file — the UI tests' clean-slate hook
    /// (launch before any store use).
    static func resetStandard() {
        try? FileManager.default.createDirectory(
            at: standardFileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? FileManager.default.removeItem(at: standardFileURL)
    }

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            self.fileURL = support.appendingPathComponent("positions.json")
        }
        entries = Self.read(from: self.fileURL)
    }

    /// The saved position for `storageKey`, or `nil` when absent or
    /// malformed.
    func load(storageKey: String) -> StoredPosition? {
        guard let entry = entries[storageKey] else { return nil }
        guard
            let chapter = entry["chapter"] as? Int,
            let index = entry["index"] as? Int,
            let offset = entry["offset"] as? Double,
            chapter >= 0, index >= 0, offset.isFinite
        else {
            return nil
        }
        return StoredPosition(
            chapter: UInt32(chapter), index: UInt32(index), offset: offset
        )
    }

    /// Persist `position` under `storageKey` (atomic rewrite).
    func save(storageKey: String, _ position: StoredPosition) {
        entries[storageKey] = [
            "chapter": Int(position.chapter),
            "index": Int(position.index),
            "offset": position.offset
        ]
        persist()
    }

    /// Drop the saved position for `storageKey` (the delete path).
    func clear(storageKey: String) {
        entries.removeValue(forKey: storageKey)
        persist()
    }

    /// Rewrite the whole map atomically — corrupt-on-crash is not a
    /// state we can land in; a torn write discards.
    private func persist() {
        guard let data = try? JSONSerialization.data(withJSONObject: entries) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    /// The tolerant read: an unparseable file is an empty store, never
    /// a crash (a future save rewrites it whole).
    private static func read(from url: URL) -> [String: [String: Any]] {
        guard
            let data = try? Data(contentsOf: url),
            let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            return [:]
        }
        var out: [String: [String: Any]] = [:]
        for (key, value) in raw {
            if let entry = value as? [String: Any] {
                out[key] = entry
            }
        }
        return out
    }
}
