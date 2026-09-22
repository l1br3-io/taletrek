import Foundation
import UIKit

/// One convert request — the dirs are explicit (the kernel's default
/// caches resolve nothing on a phone).
struct SynthJobRequest: Equatable {
    let sourcePath: String
    let hint: String?
    let voiceId: String?
    let voiceCacheDir: String
    let espeakDir: String
    let booksDir: String
    let jobs: UInt32
    let generatorApp: String
}

/// Absolute host dirs the requests carry.
struct ImportDirs: Equatable {
    let voiceCacheDir: String
    let espeakDir: String
    let booksDir: String

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
    /// Synthesizing (paragraphs done of total).
    case synthesizing(done: UInt32, total: UInt32)
    /// Serializing + writing the bundle (brief tail phase).
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
        case .preparing, .downloadingVoice, .synthesizing, .writing:
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
        case .idle, .preparing, .downloadingVoice, .synthesizing, .writing, .done, .cancelled:
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
        let h = makeHandle(config)
        handle = h
        do {
            try h.start(observer: observer)
        } catch let error as FfiPipelineSetupError {
            onTerminal(.failed(kind: "setup", message: "\(error)"))
            return
        } catch {
            onTerminal(.failed(kind: "setup", message: "\(error)"))
            return
        }
        Thread.detachNewThread {
            while true {
                switch h.state() {
                case .finished, .failed, .cancelled:
                    onTerminal(h.state())
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

    init(
        engine: SynthEngine = HandleSynthEngine(),
        armer: BackgroundArmer = UIKitBackgroundArmer()
    ) {
        self.engine = engine
        self.armer = armer
    }

    /// The instant-listen submit: a picked or shared source stages to a
    /// cache file and the FULL audio job goes in immediately — default
    /// voice, espeak ensured in-job with progress. No gate, no mode
    /// choice, no voice prerequisite. `false` when a job already owns
    /// the slot (the caller surfaces "already converting").
    @discardableResult
    func submit(source url: URL, dirs: ImportDirs, voiceId: String? = nil) -> Bool {
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
        state = .preparing(chapters: nil, paragraphs: nil)
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
    /// re-runs (deterministic ids make it idempotent).
    @discardableResult
    func retry() -> Bool {
        guard let request, state.isRetryablePhase else { return false }
        return submit(request: request, staged: stagedSource)
    }

    /// Request cancel; no-op when not running.
    func cancel() {
        engine.cancel()
    }

    /// Clear a terminal state (and any retained source with it).
    func dismiss() {
        cleanStagedSource()
        request = nil
        state = .idle
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
            }
        case let .parsed(chapters, paragraphs):
            state = .preparing(chapters: chapters, paragraphs: paragraphs)
        case let .downloadStep(done, total):
            state = .downloadingVoice(done: done, total: total)
        case let .synthStep(done, total):
            state = .synthesizing(done: done, total: total)
        }
    }

    private func finish(_ terminal: FfiPipelineState) {
        noteForegrounded()
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
    /// transient; the job needs a path the app owns.
    static func stageSource(_ url: URL) throws -> URL {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped {
                url.stopAccessingSecurityScopedResource()
            }
        }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("taletrek-sources", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent("\(UUID().uuidString)-\(url.lastPathComponent)")
        try FileManager.default.copyItem(at: url, to: target)
        return target
    }
}

extension SynthJobRequest {
    /// The kernel config. iOS only ever converts to audio — the
    /// text-only variant is a kernel/FFI capability (desktop/web), used
    /// by the tests as the CDN-free integration shape.
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
            generatorApp: generatorApp
        )
    }
}
