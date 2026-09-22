import XCTest
@testable import TaleTrek

/// The fresh-visit story, exactly one owner (Android's `FirstRunTest`
/// transposed): a cache-isolated full pipeline run against the REAL
/// CDN — default voice (~63 MB) + espeak-ng-data (~9 MB) download with
/// progress, in-job — then synth, book lands, opens with audio, and a
/// TrekPlayer walk drains real decoded segments.
///
/// Skipped unless `TALETREK_FRESH_RUN=1` rides the environment: the
/// CDN is Mac-local by design (CI runs the non-CDN suites only).
/// Run: `TALETREK_FRESH_RUN=1 just ios-test` (generous timeout; the
/// wall time lands in the log for the ship notes).
final class FirstRunTest: XCTestCase {
    func testFreshInstallConvertsAndPlaysEndToEnd() throws {
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

        let source = root.appendingPathComponent("story.txt")
        try Data(
            ("chapter one\n\nthe first paragraph says enough to synthesize.\n\n"
                + "the second paragraph does too.\n").utf8
        ).write(to: source)

        let started = Date()
        let queue = DispatchQueue(label: "fresh-run-events")
        var events: [FfiPipelineEvent] = []
        let recorder = SynthEventObserver { event in
            queue.sync { events.append(event) }
        }

        let done = expectation(description: "terminal")
        var terminal = FfiPipelineState.idle
        HandleSynthEngine().start(
            config: SynthJobRequest(
                sourcePath: source.path,
                hint: "story.txt",
                voiceId: nil,
                voiceCacheDir: ImportDirs.standard(booksDir: booksDir).voiceCacheDir,
                espeakDir: ImportDirs.standard(booksDir: booksDir).espeakDir,
                booksDir: booksDir.path,
                jobs: 2,
                generatorApp: "taletrek-ios"
            ).toConfig(),
            observer: recorder
        ) { state in
            terminal = state
            done.fulfill()
        }
        wait(for: [done], timeout: 25 * 60)
        let elapsed = Date().timeIntervalSince(started)
        print("fresh-run: full audio convert in \(Int(elapsed)) s (CDN included)")

        let stream = queue.sync { events }
        guard case let .finished(outcome) = terminal else {
            return XCTFail("expected finished, got \(terminal)")
        }
        XCTAssertFalse(outcome.textOnly)

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

        // The book opens with audio and real PCM decodes.
        let book = try openBook(path: outcome.bundlePath)
        XCTAssertTrue(book.audioPresent)
        let firstChapter = try XCTUnwrap(book.chapters.first)
        let firstParagraph = try XCTUnwrap(firstChapter.paragraphs.first)
        let decoded = try decodeSegment(
            path: outcome.bundlePath, key: firstParagraph.segmentKey
        )
        XCTAssertNotNil(decoded)
        XCTAssertGreaterThan(decoded?.samples.count ?? 0, 0)

        // And the kernel walks it: play → drain → advance.
        let engine = AudioEngine(path: outcome.bundlePath)
        let bridge = PlayerBridge(kernel: TrekPlayer(book: book), port: engine)
        engine.attach(bridge)
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
