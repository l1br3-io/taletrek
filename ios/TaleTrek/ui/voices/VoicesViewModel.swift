import Combine
import Foundation

/// The voices screen's view model over injectable FFI seams (the tests
/// drive fakes; the real seams wrap the uniffi globals). Catalog +
/// cached state + selection + download progress + delete — never a
/// prerequisite for anything (the convert lane works with zero of
/// this; the job resolves the default voice itself).
@MainActor
final class VoicesViewModel: ObservableObject {
    struct Row: Equatable, Identifiable {
        let voice: FfiVoice
        var cached: Bool

        var id: String { voice.id }
    }

    /// Live download state per voice id (bytes of total; total 0 =
    /// unknown).
    struct Download: Equatable {
        let done: UInt64
        let total: UInt64
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var selected: String?
    @Published private(set) var espeakPresent = false
    @Published private(set) var downloads: [String: Download] = [:]
    @Published private(set) var busy: Set<String> = []
    @Published private(set) var failure: (voice: String, message: String)?

    private let store: VoiceStore
    private let cacheDir: String

    // The FFI seams.
    private let catalog: () -> [FfiVoice]
    private let cachedIds: (String) -> [String]
    private let resolve: (_ id: String, _ cacheDir: String, _ observer: FfiVoiceObserver) throws -> String
    private let remove: (_ cacheDir: String, _ id: String) -> Bool
    private let espeakCheck: () -> Bool

    init(
        store: VoiceStore,
        cacheDir: String = VoicesViewModel.standardCacheDir,
        catalog: @escaping () -> [FfiVoice] = { voiceCatalog() },
        cachedIds: @escaping (String) -> [String] = { cachedVoiceIds(cacheDir: $0) },
        resolve: @escaping (
            _ id: String, _ cacheDir: String, _ observer: FfiVoiceObserver
        ) throws -> String = { id, cacheDir, observer in
            try ffiResolveVoice(id: id, cacheDir: cacheDir, observer: observer)
        },
        remove: @escaping (String, String) -> Bool = { cacheDir, id in
            deleteCachedVoice(cacheDir: cacheDir, id: id)
        },
        espeakCheck: @escaping () -> Bool = VoicesViewModel.espeakDataPresent
    ) {
        self.store = store
        self.cacheDir = cacheDir
        self.catalog = catalog
        self.cachedIds = cachedIds
        self.resolve = resolve
        self.remove = remove
        self.espeakCheck = espeakCheck
        selected = store.selected
        reload()
    }

    /// The production voice cache — the same `Application
    /// Support/voices` the convert config points at (bit-for-bit
    /// cross-app layout).
    nonisolated static var standardCacheDir: String {
        HostDirs.voicesDir.path
    }

    /// The honest espeak state: the data dir the jobs ensure carries
    /// `en_dict` when present (the pipeline downloads it on first
    /// convert — this screen only reports).
    nonisolated static func espeakDataPresent() -> Bool {
        let dict = HostDirs.espeakDir.appendingPathComponent("en_dict")
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: dict.path, isDirectory: &isDirectory)
            && !isDirectory.boolValue
    }

    func reload() {
        let cached = Set(cachedIds(cacheDir))
        rows = catalog().map { Row(voice: $0, cached: cached.contains($0.id)) }
        espeakPresent = espeakCheck()
    }

    /// Select (or deselect with nil) — persisted; the next convert job
    /// carries it.
    func select(_ id: String?) {
        store.setSelected(id)
        selected = id
    }

    func download(_ id: String) {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        failure = nil
        let observer = VoiceProgressObserver { [weak self] done, total in
            Task { @MainActor in
                self?.downloads[id] = Download(done: done, total: total)
            }
        }
        let resolver = resolve
        let dir = cacheDir
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                _ = try resolver(id, dir, observer)
                await MainActor.run {
                    guard let self else { return }
                    self.busy.remove(id)
                    self.downloads[id] = nil
                    self.reload()
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    self.busy.remove(id)
                    self.downloads[id] = nil
                    self.failure = (voice: id, message: "\(error)")
                    self.reload()
                }
            }
        }
    }

    func delete(_ id: String) {
        guard !busy.contains(id) else { return }
        _ = remove(cacheDir, id)
        if selected == id, !cachedIds(cacheDir).contains(id) {
            // A deleted selection can't be honored — back to default.
            select(nil)
        }
        reload()
    }
}

/// The FFI download observer — worker-thread callbacks hopped to the
/// main actor by the closure the view model installs.
final class VoiceProgressObserver: FfiVoiceObserver {
    private let hop: (UInt64, UInt64) -> Void

    init(hop: @escaping (UInt64, UInt64) -> Void) {
        self.hop = hop
    }

    func onDownloadStep(bytesDone: UInt64, bytesTotal: UInt64) {
        hop(bytesDone, bytesTotal)
    }
}
