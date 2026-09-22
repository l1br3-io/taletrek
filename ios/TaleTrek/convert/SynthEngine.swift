import Foundation
import UIKit

/// One convert request — the dirs are explicit (the kernel's default
/// caches resolve nothing on a phone). Every source import converts
/// **progressively**: the text bundle lands immediately, audio fills
/// the segment store horizon-first at the anchor, drain seals a full
/// bundle.
struct SynthJobRequest: Equatable {
    let sourcePath: String
    let hint: String?
    let voiceId: String?
    let voiceCacheDir: String
    let espeakDir: String
    let booksDir: String
    /// The segment store root (`Caches/taletrek/segments`) — shared
    /// across books and runs; the resume source.
    let storeDir: String
    /// Where synthesis aims first: the reader's stored position for a
    /// re-import, else the book start. Movable live via
    /// [`SynthController.reanchor`].
    var initialAnchor: FfiAnchor?
    let jobs: UInt32
    let generatorApp: String
}

/// Absolute host dirs the requests carry.
struct ImportDirs: Equatable {
    let voiceCacheDir: String
    let espeakDir: String
    let booksDir: String

    /// The segment store under `Caches/` — OS-evictable,
    /// re-synthesizable by design (Android's `<cacheDir>` stance; the
    /// LRU cap is deferred with Android until device data).
    nonisolated static var standardStoreDir: String {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("taletrek", isDirectory: true)
            .appendingPathComponent("segments", isDirectory: true)
            .path
    }

    /// Production: `Application Support/{voices,espeak-ng-data}` plus the
    /// library's scan root — the same URLs the kernel's other hosts use
    /// (bit-for-bit cross-app cache compatibility).
    static func standard(booksDir: URL) -> ImportDirs {
        ImportDirs(
            voiceCacheDir: HostDirs.voicesDir.path,
            espeakDir: HostDirs.espeakDir.path,
            booksDir: booksDir.path
        )
    }
}

/// Progress as the library's convert row renders it — derived, never
/// stored raw (Android's `SynthUiState` transposed, plus the iOS-only
/// `interrupted` for the background-expiry path).
enum SynthUiState: Equatable {
    /// No job has ever run in this process.
    case idle
    /// Parsing the document (indeterminate phase; parsed counts when
    /// known).
    case preparing(chapters: UInt32?, paragraphs: UInt32?)
    /// Downloading the voice (bytes of total; total 0 = unknown).
    case downloadingVoice(done: UInt64, total: UInt64)
    /// Synthesizing (paragraphs done of total) — pre-Playable; the
    /// book is not listenable yet.
    case synthesizing(done: UInt32, total: UInt32)
    /// Progressive: ≥ 30 s of audio exists at the anchor — the book is
    /// listenable NOW while the rest fills (the `Playable` event and
    /// every step after it).
    case filling(done: UInt32, total: UInt32)
    /// Serializing + writing the bundle (brief tail phase; the
    /// progressive seal renders here too).
    case writing
    /// Finished: the outcome of a successful run.
    case done(bookId: String, bundlePath: String)
    /// Failed: stable kernel error kind + human message. Retryable.
    case failed(kind: String, message: String)
    /// Cancelled by the user; no partial book exists.
    case cancelled
    /// The background grace expired mid-synth: the job cancelled
    /// cleanly (atomic write — no partial book; deterministic ids — a
    /// retry is idempotent). One-tap retry.
    case interrupted
}

extension SynthUiState {
    /// A job owns the single slot (any pre-terminal phase).
    var isRunningPhase: Bool {
        switch self {
        case .preparing, .downloadingVoice, .synthesizing, .filling, .writing:
            return true
        case .idle, .done, .failed, .cancelled, .interrupted:
            return false
        }
    }

    /// The terminals that offer retry (and therefore retain the staged
    /// source).
    var isRetryablePhase: Bool {
        switch self {
        case .failed, .interrupted:
            return true
        case .idle, .preparing, .downloadingVoice, .synthesizing, .filling, .writing, .done, .cancelled:
            return false
        }
    }

    /// The paragraph counts any synth-phase state carries — the filling
    /// row's "n of t" currency (nil when unknown).
    var paragraphCounts: (done: UInt32, total: UInt32)? {
        switch self {
        case let .synthesizing(done, total), let .filling(done, total):
            return (done, total)
        default:
            return nil
        }
    }

    /// Whether the state carries paragraph progress (pre- or
    /// post-Playable) — the fill-rescan trigger's currency (the
    /// progressive text bundle has landed by the time synth starts).
    var isSynthPhase: Bool {
        switch self {
        case .synthesizing, .filling:
            return true
        default:
            return false
        }
    }
}

/// The pipeline engine seam — everything the controller needs from the
/// kernel handle, shaped so the tests drive fakes.
protocol SynthEngine: AnyObject, Sendable {
    /// Start one job; `onTerminal` fires exactly once with the end
    /// state.
    func start(
        config: FfiPipelineConfig,
        observer: PipelineObserver,
        onTerminal: @escaping (FfiPipelineState) -> Void
    )

    /// Request cancellation (no-op when idle).
    func cancel()

    /// Move the scheduling anchor (progressive only; no-op when idle).
    func reanchor(_ anchor: FfiAnchor)
}

/// [`SynthEngine`] over the real [`PipelineHandle`]. Events stream live
/// through the observer (worker threads — the hop is the caller's);
/// the terminal state is polled off-thread because the FFI event
/// stream has no terminal event by design (state is the poll API).
/// Setup failures (unreadable source, double start) surface as a
/// `setup` Failed terminal instead of a crash.
final class HandleSynthEngine: SynthEngine {
    private let makeHandle: (FfiPipelineConfig) -> PipelineHandle
    private var handle: PipelineHandle?

    init(makeHandle: @escaping (FfiPipelineConfig) -> PipelineHandle = { PipelineHandle(config: $0) }) {
        self.makeHandle = makeHandle
    }

    func start(
        config: FfiPipelineConfig,
        observer: PipelineObserver,
        onTerminal: @escaping (FfiPipelineState) -> Void
    ) {
        let newHandle = makeHandle(config)
        handle = newHandle
        do {
            try newHandle.start(observer: observer)
        } catch let error as FfiPipelineSetupError {
            onTerminal(.failed(kind: "setup", message: "\(error)"))
            return
        } catch {
            onTerminal(.failed(kind: "setup", message: "\(error)"))
            return
        }
        Thread.detachNewThread {
            while true {
                switch newHandle.state() {
                case .finished, .failed, .cancelled:
                    onTerminal(newHandle.state())
                    return
                case .idle, .running:
                    Thread.sleep(forTimeInterval: 0.15)
                }
            }
        }
    }

    func cancel() {
        handle?.cancel()
    }

    func reanchor(_ anchor: FfiAnchor) {
        handle?.setAnchor(anchor: anchor)
    }
}

/// The observer bridge: kernel events on worker threads, hopped to the
/// main actor by the closure the controller installs.
final class SynthEventObserver: PipelineObserver {
    private let hop: (FfiPipelineEvent) -> Void

    init(hop: @escaping (FfiPipelineEvent) -> Void) {
        self.hop = hop
    }

    func onPipelineEvent(event: FfiPipelineEvent) {
        hop(event)
    }
}

/// The background-grace seam — `UIApplication.beginBackgroundTask` in
/// production, the test's hands otherwise.
protocol BackgroundArmer: AnyObject {
    /// Arm the expiry; the returned closure disarms (end the task).
    func arm(onExpiry: @escaping () -> Void) -> () -> Void
}

final class UIKitBackgroundArmer: BackgroundArmer {
    func arm(onExpiry: @escaping () -> Void) -> () -> Void {
        let id = UIApplication.shared.beginBackgroundTask(withName: "taletrek-synth") {
            onExpiry()
        }
        return { UIApplication.shared.endBackgroundTask(id) }
    }
}

/// The convert state machine — the phone-processor's controller.
///
/// Foreground-only by design (user-locked): converting while
/// backgrounded buys `beginBackgroundTask` grace (~30 s, varies) and
/// then **cancels cleanly** into `.interrupted` — one-tap retry, no
/// partial book (atomic write), idempotent re-runs (deterministic
/// ids). **No correctness depends on the grace window** — rejected
/// alternatives (silent-audio keepalive: dishonest session + review
/// risk; BGProcessingTask: system-scheduled, not user-initiated).
///
/// The staged source copy's lifecycle: spent (`done`/`cancelled`/
/// dismissed) sources are cleaned immediately; retryable terminals
/// (`failed`/`interrupted`) retain theirs for the retry they offer —
/// the next terminal or the dismissal cleans it (bounded retention,
/// never a growing pile).
@MainActor
final class SynthController: ObservableObject {
    @Published private(set) var state: SynthUiState = .idle

    /// A finished job asks the library to rescan (the row appears).
    var onFinished: (() -> Void)?

    private let engine: SynthEngine
    private let armer: BackgroundArmer

    private var request: SynthJobRequest?
    private var stagedSource: URL?
    private var endBackground: (() -> Void)?
    private var expiryCancelled = false
    /// Whether the `Playable` event has fired for the live job — the
    /// filling/synthesizing currency switch.
    private var playable = false

    init(
        engine: SynthEngine = HandleSynthEngine(),
        armer: BackgroundArmer = UIKitBackgroundArmer()
    ) {
        self.engine = engine
        self.armer = armer
    }

    /// The instant-listen submit: a picked or shared source stages to a
    /// cache file and the progressive audio job goes in immediately —
    /// default voice, espeak ensured in-job with progress, the text
    /// bundle lands first and the audio fills at the anchor. No gate,
    /// no mode choice, no voice prerequisite. `false` when a job
    /// already owns the slot (the caller surfaces "already
    /// converting").
    @discardableResult
    func submit(source url: URL, dirs: ImportDirs, voiceId: String? = nil, anchor: FfiAnchor? = nil) -> Bool {
        guard !state.isRunningPhase else { return false }
        let staged: URL
        do {
            staged = try Self.stageSource(url)
        } catch {
            state = .failed(kind: "stage", message: error.localizedDescription)
            return true
        }
        return submit(
            request: SynthJobRequest(
                sourcePath: staged.path,
                hint: url.lastPathComponent,
                voiceId: voiceId,
                voiceCacheDir: dirs.voiceCacheDir,
                espeakDir: dirs.espeakDir,
                booksDir: dirs.booksDir,
                storeDir: ImportDirs.standardStoreDir,
                initialAnchor: anchor,
                jobs: 2,
                generatorApp: "taletrek-ios"
            ),
            staged: staged
        )
    }

    @discardableResult
    func submit(request: SynthJobRequest, staged: URL?) -> Bool {
        guard !state.isRunningPhase else { return false }
        self.request = request
        stagedSource = staged
        playable = false
        state = .preparing(chapters: nil, paragraphs: nil)
        PendingImport.save(Self.pendingRecordURL(booksDir: request.booksDir), request)
        // The store is the resume source and the filling reader's
        // read-through cache — registered before the job starts
        // (Android's submit-time wiring; launch wiring is the
        // belt-and-braces first path).
        setSegmentStore(dir: request.storeDir)
        let observer = SynthEventObserver { [weak self] event in
            Task { @MainActor in
                self?.apply(event)
            }
        }
        engine.start(config: request.toConfig(), observer: observer) { [weak self] terminal in
            Task { @MainActor in
                self?.finish(terminal)
            }
        }
        return true
    }

    /// One-tap retry from a retryable terminal — the same request
    /// re-runs (deterministic ids make it idempotent; the store makes
    /// it cheap — done keys skip).
    @discardableResult
    func retry() -> Bool {
        guard let request, state.isRetryablePhase else { return false }
        return submit(request: request, staged: stagedSource)
    }

    /// Request cancel; no-op when not running.
    func cancel() {
        engine.cancel()
    }

    /// Move the live job's scheduling anchor to the reader's playhead
    /// (progressive only; no-op when idle — one job, so the anchor
    /// follows whichever book is actually filling).
    func reanchor(_ anchor: FfiAnchor) {
        guard state.isRunningPhase else { return }
        engine.reanchor(anchor)
    }

    /// Clear a terminal state (and any retained source with it).
    func dismiss() {
        cleanStagedSource()
        request = nil
        state = .idle
    }

    /// Relaunch resume (Android `PendingJobStore` parity): a record
    /// surviving a process death mid-synth re-submits here — the
    /// segment store makes it cheap (done keys skip, no re-download).
    /// An evicted source clears the record instead.
    func resumePending(booksDir: URL) {
        guard !state.isRunningPhase else { return }
        let recordURL = Self.pendingRecordURL(booksDir: booksDir.path)
        guard let record = PendingImport.load(recordURL) else { return }
        let staged = URL(fileURLWithPath: record.request.sourcePath)
        guard FileManager.default.fileExists(atPath: staged.path) else {
            PendingImport.clear(recordURL)
            return
        }
        _ = submit(request: record.request, staged: staged)
    }

    nonisolated static func pendingRecordURL(booksDir: String) -> URL {
        URL(fileURLWithPath: booksDir)
            .deletingLastPathComponent()
            .appendingPathComponent("pending-import.json")
    }

    /// Scene-phase: backgrounding arms the grace; expiry cancels into
    /// `.interrupted`.
    func noteBackgrounded() {
        guard state.isRunningPhase, endBackground == nil else { return }
        endBackground = armer.arm { [weak self] in
            Task { @MainActor in
                guard let self, self.state.isRunningPhase else { return }
                self.expiryCancelled = true
                self.engine.cancel()
            }
        }
    }

    /// Scene-phase: back in the foreground disarms the grace (the job
    /// kept running through the window).
    func noteForegrounded() {
        if let endBackground {
            endBackground()
        }
        endBackground = nil
    }

    // --- internals --------------------------------------------------------

    private func apply(_ event: FfiPipelineEvent) {
        guard state.isRunningPhase else { return }
        switch event {
        case let .phase(phase):
            switch phase {
            case .parsing, .resolvingVoice:
                state = .preparing(chapters: nil, paragraphs: nil)
            case .synthesizing:
                state = .synthesizing(done: 0, total: 0)
            case .writing:
                state = .writing
            case .sealing:
                // The progressive seal: the merged full bundle is
                // landing atomically — the writing phase's shape.
                state = .writing
            }
        case let .parsed(chapters, paragraphs):
            state = .preparing(chapters: chapters, paragraphs: paragraphs)
        case let .downloadStep(done, total):
            state = .downloadingVoice(done: done, total: total)
        case let .synthStep(done, total):
            // Playable flips the currency: the book is listenable, the
            // rest of the run renders as filling.
            state = playable
                ? .filling(done: done, total: total)
                : .synthesizing(done: done, total: total)
        case .playable:
            playable = true
            if let counts = state.paragraphCounts {
                state = .filling(done: counts.done, total: counts.total)
            } else {
                state = .filling(done: 0, total: 0)
            }
        case .sealed:
            state = .writing
        }
    }

    private func finish(_ terminal: FfiPipelineState) {
        noteForegrounded()
        PendingImport.clear(Self.pendingRecordURL(booksDir: request?.booksDir ?? ""))
        switch terminal {
        case .idle, .running:
            break // the poll reports terminals only; defensive
        case let .finished(outcome):
            state = .done(bookId: outcome.bookId, bundlePath: outcome.bundlePath)
            cleanStagedSource()
            onFinished?()
        case let .failed(kind, message):
            state = .failed(kind: kind, message: message)
        case .cancelled:
            let interrupted = expiryCancelled
            expiryCancelled = false
            state = interrupted ? .interrupted : .cancelled
            if !interrupted {
                cleanStagedSource()
            }
        }
    }

    private func cleanStagedSource() {
        if let stagedSource {
            try? FileManager.default.removeItem(at: stagedSource)
        }
        stagedSource = nil
    }

    /// Copy a picked/opened source to a cache file — open-in grants are
    /// transient; the job needs a path the app owns. `Caches/taletrek/
    /// sources/` (OS-evictable; the pending record tolerates eviction
    /// by clearing) so a relaunch after process death can still resume.
    static func stageSource(_ url: URL) throws -> URL {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped {
                url.stopAccessingSecurityScopedResource()
            }
        }
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("taletrek", isDirectory: true)
            .appendingPathComponent("sources", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent("\(UUID().uuidString)-\(url.lastPathComponent)")
        try FileManager.default.copyItem(at: url, to: target)
        return target
    }
}

extension SynthJobRequest {
    /// The kernel config — the progressive variant for every source
    /// import (text bundle first, store fill at the anchor, seal on
    /// drain). The text-only variant stays a kernel/FFI capability the
    /// tests use as the CDN-free integration shape (progressive is
    /// ignored when text-only).
    func toConfig(textOnly: Bool = false) -> FfiPipelineConfig {
        FfiPipelineConfig(
            sourcePath: sourcePath,
            hint: hint,
            textOnly: textOnly,
            voiceId: voiceId,
            voiceCacheDir: voiceCacheDir,
            espeakDir: espeakDir,
            booksDir: booksDir,
            jobs: jobs,
            generatorApp: generatorApp,
            progressive: textOnly
                ? nil
                : FfiProgressiveConfig(storeDir: storeDir, initialAnchor: initialAnchor)
        )
    }
}

/// The relaunch-resume record — Android's `PendingJobStore` parity:
/// process death mid-synth must not lose the job. The request persists
/// as one JSON file beside the books dir; a relaunch re-submits from it
/// (the segment store makes resume cheap — done keys skip, no voice
/// re-download). An evicted staged source clears the record.
enum PendingImport {
    struct Record: Codable, Equatable {
        var sourcePath: String
        var hint: String?
        var voiceId: String?
        var voiceCacheDir: String
        var espeakDir: String
        var booksDir: String
        var storeDir: String
        var anchorChapter: UInt32?
        var anchorParagraph: UInt32?
        var jobs: UInt32
        var generatorApp: String

        init(request: SynthJobRequest) {
            sourcePath = request.sourcePath
            hint = request.hint
            voiceId = request.voiceId
            voiceCacheDir = request.voiceCacheDir
            espeakDir = request.espeakDir
            booksDir = request.booksDir
            storeDir = request.storeDir
            anchorChapter = request.initialAnchor?.chapter
            anchorParagraph = request.initialAnchor?.paragraph
            jobs = request.jobs
            generatorApp = request.generatorApp
        }

        var request: SynthJobRequest {
            let anchor = anchorChapter.flatMap { chapter in
                anchorParagraph.map { paragraph in
                    FfiAnchor(chapter: chapter, paragraph: paragraph)
                }
            }
            return SynthJobRequest(
                sourcePath: sourcePath,
                hint: hint,
                voiceId: voiceId,
                voiceCacheDir: voiceCacheDir,
                espeakDir: espeakDir,
                booksDir: booksDir,
                storeDir: storeDir,
                initialAnchor: anchor,
                jobs: jobs,
                generatorApp: generatorApp
            )
        }
    }

    static func save(_ url: URL, _ request: SynthJobRequest) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(Record(request: request)) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func load(_ url: URL) -> Record? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    static func clear(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}
