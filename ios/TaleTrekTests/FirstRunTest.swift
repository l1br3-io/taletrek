import XCTest
@testable import TaleTrek

/// The fresh-visit story, exactly one owner (Android's `FirstRunTest`
/// transposed onto the progressive baseline): a cache-isolated full
/// pipeline run against the REAL CDN — default voice (~63 MB) +
/// espeak-ng-data (~9 MB) download with progress, in-job — then the
/// **text-only book lands immediately**, audio fills at the anchor,
/// `Playable` arrives while the job still reports progress
/// (listen-before-completion), a TrekPlayer walk drains real decoded
/// segments, and the seal completes the book.
///
/// Skipped unless `TALETREK_FRESH_RUN=1` rides the environment: the
/// CDN is Mac-local by design (CI runs the non-CDN suites only).
/// Run: `TALETREK_FRESH_RUN=1 just ios-test` (generous timeout; the
/// wall time lands in the log for the ship notes).
@MainActor
final class FirstRunTest: XCTestCase {
    func testFreshInstallConvertsPlaysWhileFillingAndSeals() throws {
        guard ProcessInfo.processInfo.environment["TALETREK_FRESH_RUN"] == "1" else {
            throw XCTSkip(
                "fresh-run owns the real CDN (~72 MB) — Mac-local by design. "
                    + "Run with TALETREK_FRESH_RUN=1 just ios-test."
            )
        }

        // The isolation root: set before anything reads HostDirs (the
        // reads are lazy, so this shapes the whole run).
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("taletrek-fresh-\(UUID().uuidString)", isDirectory: true)
        let booksDir = root.appendingPathComponent("books", isDirectory: true)
        try FileManager.default.createDirectory(at: booksDir, withIntermediateDirectories: true)
        setenv("TALETREK_CACHE_ROOT", root.path, 1)
        defer { try? FileManager.default.removeItem(at: root) }

        // Sized for PLAYABLE_SECONDS (15 s at ~18 chars/s ≈ 270 chars):
        // each distinct paragraph runs ~6 s of audio, so the third
        // delivery crosses the playable horizon mid-run and three more
        // keep synthesis flowing past it (listen-before-completion).
        // Distinctness matters — duplicate texts share a cache key.
        let paragraphs = (1...6).map { ordinal in
            "paragraph number \(ordinal) carries enough words to hold several seconds of spoken audio, so the store keeps filling while the reader listens ahead."
        }
        let source = root.appendingPathComponent("story.txt")
        try Data(
            ("chapter one\n\n" + paragraphs.joined(separator: "\n\n") + "\n").utf8
        ).write(to: source)

        let started = Date()
        let queue = DispatchQueue(label: "fresh-run-events")
        var events: [FfiPipelineEvent] = []
        let recorder = SynthEventObserver { event in
            queue.sync { events.append(event) }
        }

        // The store under the same isolation root (the resume source
        // and the filling reader's read-through cache).
        let storeDir = root.appendingPathComponent("store", isDirectory: true).path

        // The controller drives; the recorder rides the observer seam
        // through a tee so the real event stream is captured verbatim.
        let engine = TeeEngine(inner: HandleSynthEngine()) { event in
            recorder.onPipelineEvent(event: event)
        }
        let controller = SynthController(engine: engine, armer: UIKitBackgroundArmer())
        controller.submit(
            request: SynthJobRequest(
                sourcePath: source.path,
                hint: "story.txt",
                voiceId: nil,
                voiceCacheDir: ImportDirs.standard(booksDir: booksDir).voiceCacheDir,
                espeakDir: ImportDirs.standard(booksDir: booksDir).espeakDir,
                booksDir: booksDir.path,
                storeDir: storeDir,
                initialAnchor: nil,
                jobs: 2,
                generatorApp: "taletrek-ios"
            ),
            staged: source
        )
        guard case .preparing = controller.state else {
            return XCTFail("expected the job to start preparing")
        }
        // Terminal = the controller leaves its running phases.
        let done = expectation(description: "terminal")
        let poller = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { timer in
            Task { @MainActor in
                if !controller.state.isRunningPhase, controller.state != .idle {
                    timer.invalidate()
                    done.fulfill()
                }
            }
        }
        wait(for: [done], timeout: 25 * 60)
        poller.invalidate()
        let elapsed = Date().timeIntervalSince(started)
        print("fresh-run: progressive convert in \(Int(elapsed)) s (CDN included)")

        let stream = queue.sync { events }
        guard case let .done(bookId, bundlePath) = controller.state else {
            return XCTFail("expected done, got \(controller.state)")
        }
        let outcome = (bookId: bookId, bundlePath: bundlePath)

        // First-run caches actually landed (nothing was pre-warmed).
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: HostDirs.espeakDir.appendingPathComponent("en_dict").path
            ),
            "the job ensured espeak-ng-data itself"
        )
        let cached = cachedVoiceIds(cacheDir: HostDirs.voicesDir.path)
        XCTAssertFalse(cached.isEmpty, "the default voice downloaded in-job")

        // Download progress was observed, monotonic.
        let steps = stream.filter {
            if case .downloadStep = $0 { return true }
            return false
        }.count
        XCTAssertGreaterThan(steps, 0, "voice download streamed progress")

        // The progressive story: the text bundle landed before any
        // audio existed, Playable arrived, and synthesis was still
        // running when it did (listen-before-completion).
        let playableAt = stream.firstIndex {
            if case .playable = $0 { return true }
            return false
        }
        XCTAssertNotNil(playableAt, "Playable arrived — listenable mid-run")
        if let playableAt {
            let progressAfter = stream[playableAt...].contains {
                if case .synthStep = $0 { return true }
                return false
            }
            XCTAssertTrue(progressAfter, "synthesis continued past Playable")
        }

        // The sealed book opens with audio, real PCM decodes, and the
        // kernel walks it: play → drain → advance.
        try walkSealedBook(bundlePath: outcome.bundlePath)
    }

    /// The sealed tail of the story: full bundle, decodable audio, and
    /// a live TrekPlayer walk that advances past paragraph 0.
    private func walkSealedBook(bundlePath: String) throws {
        let book = try openBook(path: bundlePath)
        XCTAssertTrue(book.audioPresent, "the seal produced a full bundle")
        let firstChapter = try XCTUnwrap(book.chapters.first)
        let firstParagraph = try XCTUnwrap(firstChapter.paragraphs.first)
        let decoded = try decodeSegment(
            path: bundlePath, key: firstParagraph.segmentKey
        )
        XCTAssertNotNil(decoded)
        XCTAssertGreaterThan(decoded?.samples.count ?? 0, 0)

        let walkEngine = AudioEngine(path: bundlePath)
        let bridge = PlayerBridge(kernel: TrekPlayer(book: book), port: walkEngine)
        walkEngine.attach(bridge)
        bridge.userPlay()
        let advanced = expectation(description: "advanced past paragraph 0")
        let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
            if bridge.snapshot.para?.index == 1 {
                timer.invalidate()
                advanced.fulfill()
            }
        }
        wait(for: [advanced], timeout: 30)
        timer.invalidate()
    }
}

/// Wraps an engine so the observer stream is captured verbatim while
/// the controller's own mapping rides untouched (the fresh-run test's
/// recorder seam).
final class TeeEngine: SynthEngine {
    private let inner: SynthEngine
    private let tee: (FfiPipelineEvent) -> Void

    init(inner: SynthEngine, tee: @escaping (FfiPipelineEvent) -> Void) {
        self.inner = inner
        self.tee = tee
    }

    func start(
        config: FfiPipelineConfig,
        observer: PipelineObserver,
        onTerminal: @escaping (FfiPipelineState) -> Void
    ) {
        inner.start(
            config: config,
            observer: TeeObserver(original: observer, tee: tee),
            onTerminal: onTerminal
        )
    }

    func cancel() {
        inner.cancel()
    }

    func reanchor(_ anchor: FfiAnchor) {
        inner.reanchor(anchor)
    }
}

private final class TeeObserver: PipelineObserver {
    private let original: PipelineObserver
    private let tee: (FfiPipelineEvent) -> Void

    init(original: PipelineObserver, tee: @escaping (FfiPipelineEvent) -> Void) {
        self.original = original
        self.tee = tee
    }

    func onPipelineEvent(event: FfiPipelineEvent) {
        tee(event)
        original.onPipelineEvent(event: event)
    }
}
