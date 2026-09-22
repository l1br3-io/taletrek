import XCTest
@testable import TaleTrek

/// The convert state machine: units over a faked engine (event mapping,
/// the instant-listen config, the single slot, the background-expiry
/// Interrupted path with retry, source-lifecycle rules) + REAL
/// kernel integrations on the text-only pipeline (the CDN-free shape —
/// the full-audio legs ride task 011's pre-warmed/fresh-run suites).
@MainActor
final class SynthEngineTests: XCTestCase {
    private final class FakeEngine: SynthEngine {
        var configs: [FfiPipelineConfig] = []
        var observer: PipelineObserver?
        var onTerminal: ((FfiPipelineState) -> Void)?
        private(set) var cancels = 0

        func start(
            config: FfiPipelineConfig,
            observer: PipelineObserver,
            onTerminal: @escaping (FfiPipelineState) -> Void
        ) {
            configs.append(config)
            self.observer = observer
            self.onTerminal = onTerminal
        }

        func cancel() {
            cancels += 1
        }
    }

    private final class FakeArmer: BackgroundArmer {
        private(set) var armed = 0
        private(set) var disarmed = 0
        var onExpiry: (() -> Void)?

        func arm(onExpiry: @escaping () -> Void) -> () -> Void {
            armed += 1
            self.onExpiry = onExpiry
            return { [weak self] in self?.disarmed += 1 }
        }
    }

    private func waitUntil(
        timeout: TimeInterval = 5, _ message: String, _ condition: @escaping () -> Bool
    ) {
        let fulfilled = expectation(description: message)
        let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { timer in
            if condition() {
                timer.invalidate()
                fulfilled.fulfill()
            }
        }
        wait(for: [fulfilled], timeout: timeout)
        timer.invalidate()
    }

    /// A pickable source: a bare `story.txt` inside a unique directory —
    /// the name is the premise the `hint` assertion rides (a real pick
    /// is named what the user's file is named; the staging copy adds
    /// the UUID, the hint must not carry it).
    private func makeSource(name: String = "story.txt") throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("src-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try Data("chapter one\n\nfirst paragraph here.\n\nsecond paragraph here.\n".utf8)
            .write(to: url)
        return url
    }

    private let dirs = ImportDirs(voiceCacheDir: "/v", espeakDir: "/e", booksDir: "/b")

    func testSubmitBuildsTheInstantListenConfigAndMapsEvents() throws {
        let engine = FakeEngine()
        let controller = SynthController(engine: engine, armer: FakeArmer())
        let source = try makeSource()

        XCTAssertTrue(controller.submit(source: source, dirs: dirs))

        let config = try XCTUnwrap(engine.configs.first)
        XCTAssertEqual(config.hint, "story.txt")
        XCTAssertFalse(config.textOnly, "iOS only ever submits the full audio job")
        XCTAssertNil(config.voiceId, "nil = the kernel's default voice")
        XCTAssertEqual(config.jobs, 2)
        XCTAssertEqual(config.generatorApp, "taletrek-ios")
        XCTAssertEqual(config.voiceCacheDir, "/v")
        XCTAssertEqual(config.espeakDir, "/e")
        XCTAssertEqual(config.booksDir, "/b")
        XCTAssertTrue(config.sourcePath.contains("taletrek-sources"))

        XCTAssertEqual(controller.state, .preparing(chapters: nil, paragraphs: nil))

        let observer = try XCTUnwrap(engine.observer)
        // Events hop to the main actor before they land — each mapped
        // state is awaited, not assumed synchronous.
        observer.onPipelineEvent(event: .parsed(chapters: 1, paragraphs: 2))
        waitUntil("parsed shape lands") {
            controller.state == .preparing(chapters: 1, paragraphs: 2)
        }
        observer.onPipelineEvent(event: .downloadStep(bytesDone: 10, bytesTotal: 100))
        waitUntil("download progress maps") {
            controller.state == .downloadingVoice(done: 10, total: 100)
        }
        observer.onPipelineEvent(event: .phase(.synthesizing))
        waitUntil("synth phase maps") { controller.state == .synthesizing(done: 0, total: 0) }
        observer.onPipelineEvent(event: .synthStep(done: 1, total: 2))
        waitUntil("synth progress maps") {
            controller.state == .synthesizing(done: 1, total: 2)
        }
        observer.onPipelineEvent(event: .phase(.writing))
        waitUntil("writing phase maps") { controller.state == .writing }
    }

    func testSubmitWhileRunningIsRejected() throws {
        let engine = FakeEngine()
        let controller = SynthController(engine: engine, armer: FakeArmer())

        XCTAssertTrue(controller.submit(source: try makeSource(), dirs: dirs))
        XCTAssertFalse(
            controller.submit(source: try makeSource(), dirs: dirs),
            "one job owns the single slot"
        )
        XCTAssertEqual(engine.configs.count, 1)
    }

    func testBackgroundExpiryCancelsIntoInterruptedAndRetryReruns() throws {
        let engine = FakeEngine()
        let armer = FakeArmer()
        let controller = SynthController(engine: engine, armer: armer)
        let source = try makeSource()
        XCTAssertTrue(controller.submit(source: source, dirs: dirs))

        controller.noteBackgrounded()
        XCTAssertEqual(armer.armed, 1)

        armer.onExpiry?()
        waitUntil("expiry reached the engine as a cancel") { engine.cancels == 1 }

        let stagedPath = engine.configs[0].sourcePath
        engine.onTerminal?(.cancelled)
        waitUntil("cancelled into the typed interruption") { controller.state == .interrupted }
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: stagedPath),
            "interrupted retains the staged source for its retry"
        )

        // The staged source survives for the retry it offers.
        XCTAssertTrue(controller.retry(), "interrupted retries the same request")
        XCTAssertEqual(engine.configs.count, 2)
        waitUntil("retry is running") { controller.state.isRunningPhase }

        engine.onTerminal?(.finished(fixtureOutcome))
        waitUntil("the retry finished") { controller.state != .interrupted && !controller.state.isRunningPhase }
        if case .done = controller.state {} else {
            XCTFail("expected done, got \(controller.state)")
        }
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: stagedPath),
            "the retry's terminal cleaned the staged source"
        )
        XCTAssertEqual(armer.disarmed, 1, "the terminal disarmed the expired window")
    }

    func testUserCancelCleansStagedSourceAndIsNotRetryable() throws {
        let engine = FakeEngine()
        let controller = SynthController(engine: engine, armer: FakeArmer())
        XCTAssertTrue(controller.submit(source: try makeSource(), dirs: dirs))

        controller.cancel()
        engine.onTerminal?(.cancelled)
        waitUntil("cancelled") { controller.state == .cancelled }

        XCTAssertFalse(controller.retry(), "a user cancel is spent — pick again")
    }

    func testFailedRetainsTheStagedSourceUntilTheRetryTerminates() throws {
        let engine = FakeEngine()
        let controller = SynthController(engine: engine, armer: FakeArmer())
        XCTAssertTrue(controller.submit(source: try makeSource(), dirs: dirs))

        engine.onTerminal?(.failed(kind: "voice", message: "offline"))
        waitUntil("failed is surfaced") {
            controller.state == .failed(kind: "voice", message: "offline")
        }

        XCTAssertTrue(controller.retry())
        engine.onTerminal?(.finished(fixtureOutcome))
        waitUntil("done") {
            if case .done = controller.state { return true }
            return false
        }
    }

    func testDoneSignalsTheLibraryAndCleansUp() throws {
        let engine = FakeEngine()
        let controller = SynthController(engine: engine, armer: FakeArmer())
        XCTAssertTrue(controller.submit(source: try makeSource(), dirs: dirs))

        let signaled = expectation(description: "onFinished fired")
        controller.onFinished = { signaled.fulfill() }

        engine.onTerminal?(.finished(fixtureOutcome))
        wait(for: [signaled], timeout: 5)
    }

    private var fixtureOutcome: FfiPipelineOutcome {
        FfiPipelineOutcome(
            bookId: "bk_x",
            bundlePath: "/b/bk_x.taletrek",
            textOnly: false,
            chapters: 1,
            paragraphs: 2,
            segments: 2
        )
    }
}

/// Real-kernel integrations over the text-only pipeline (CDN-free by
/// design — the voice/espeak legs ride task 011's Mac-local suites).
final class SynthPipelineIntegrationTests: XCTestCase {
    private var booksDir: URL!
    private var source: URL!

    override func setUpWithError() throws {
        booksDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("books-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: booksDir, withIntermediateDirectories: true)
        source = FileManager.default.temporaryDirectory
            .appendingPathComponent("src-\(UUID().uuidString).txt")
        try Data("chapter one\n\nfirst paragraph here.\n\nsecond paragraph here.\n".utf8)
            .write(to: source)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: booksDir)
        try? FileManager.default.removeItem(at: source)
    }

    private func request(jobs: UInt32 = 2) -> SynthJobRequest {
        SynthJobRequest(
            sourcePath: source.path,
            hint: "story.txt",
            voiceId: nil,
            voiceCacheDir: booksDir.appendingPathComponent("voices").path,
            espeakDir: booksDir.appendingPathComponent("espeak-ng-data").path,
            booksDir: booksDir.path,
            jobs: jobs,
            generatorApp: "taletrek-ios"
        )
    }

    /// The recorded event stream (worker threads — serialized by the
    /// queue) + the terminal, through the real engine + real pipeline.
    private func runTextOnly(_ config: FfiPipelineConfig, timeout: TimeInterval = 60)
        -> (events: [FfiPipelineEvent], terminal: FfiPipelineState) {
        let queue = DispatchQueue(label: "test-events")
        var events: [FfiPipelineEvent] = []
        let recorder = SynthEventObserver { event in
            queue.sync { events.append(event) }
        }
        let done = expectation(description: "terminal")
        var terminal = FfiPipelineState.idle
        let engine = HandleSynthEngine()
        engine.start(config: config, observer: recorder) { state in
            terminal = state
            done.fulfill()
        }
        wait(for: [done], timeout: timeout)
        return (queue.sync { events }, terminal)
    }

    func testTextOnlyPipelineRunsToDoneAndLandsTheBook() throws {
        let run = runTextOnly(request().toConfig(textOnly: true))

        guard case let .finished(outcome) = run.terminal else {
            return XCTFail("expected finished, got \(run.terminal)")
        }
        XCTAssertTrue(outcome.textOnly)
        XCTAssertEqual(outcome.chapters, 1)
        XCTAssertEqual(outcome.paragraphs, 2)
        let bundle = URL(fileURLWithPath: outcome.bundlePath)
        XCTAssertEqual(
            bundle.deletingLastPathComponent().path,
            booksDir.path,
            "the book lands in the scan root"
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundle.path))

        let book = try openBook(path: outcome.bundlePath)
        XCTAssertFalse(book.audioPresent, "text-only by construction")

        let phases = run.events.map(\.phaseIfAny)
        XCTAssertTrue(phases.contains(.parsing))
        XCTAssertTrue(phases.contains(.writing))
    }

    func testTheSixSourceFormatsConvertThroughTheLane() throws {
        let fixtures = [
            "plain.txt", "book.epub", "with-outline.pdf",
            "doc.docx", "article.html", "book.md",
        ]
        for fixture in fixtures {
            let url = try XCTUnwrap(
                Bundle(for: SynthPipelineIntegrationTests.self).url(
                    forResource: (fixture as NSString).deletingPathExtension,
                    withExtension: (fixture as NSString).pathExtension
                ),
                "fixture \(fixture) rides the test bundle's resources"
            )
            source = url
            let run = runTextOnly(request().toConfig(textOnly: true))
            guard case .finished = run.terminal else {
                XCTFail("\(fixture): expected finished, got \(run.terminal)")
                continue
            }
        }
    }
}

extension FfiPipelineEvent {
    /// The phase, when this event is one (test sugar).
    var phaseIfAny: FfiPipelinePhase? {
        if case let .phase(phase) = self {
            return phase
        }
        return nil
    }
}
