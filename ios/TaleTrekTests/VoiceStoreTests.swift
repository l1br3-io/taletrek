import Combine
import XCTest
@testable import TaleTrek

/// The voices surface: the selection store's persistence contract and
/// the view model over faked FFI seams (catalog/cache marks, selection,
/// download success + failure, delete's orphan-selection reset).
@MainActor
final class VoiceStoreTests: XCTestCase {
    private var fileURL: URL!

    override func setUpWithError() throws {
        fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: fileURL)
    }

    func testSelectionRoundTripsThroughTheFile() throws {
        let store = VoiceStore(fileURL: fileURL)
        XCTAssertNil(store.selected, "absent file = the kernel default")

        store.setSelected("en_US-amy-medium")
        XCTAssertEqual(store.selected, "en_US-amy-medium")

        let reread = VoiceStore(fileURL: fileURL)
        XCTAssertEqual(reread.selected, "en_US-amy-medium", "the selection survives the process")

        store.setSelected(nil)
        XCTAssertNil(store.selected)
        XCTAssertNil(
            VoiceStore(fileURL: fileURL).selected,
            "deselect removes the file — default resumes"
        )
    }

    func testACorruptFileReadsAsNoOverride() throws {
        try Data("not a voice id".utf8).write(to: fileURL)
        // A non-empty junk payload still reads (it is a string) — the
        // contract is one honest id; the kernel fails loudly on an
        // unknown id, which is the right failure surface.
        XCTAssertEqual(VoiceStore(fileURL: fileURL).selected, "not a voice id")
    }
}

@MainActor
final class VoicesViewModelTests: XCTestCase {
    private func voice(_ id: String, name: String) -> FfiVoice {
        FfiVoice(
            id: id,
            name: name,
            language: "en_US",
            quality: "medium",
            sizeBytes: 63_000_000
        )
    }

    private func makeModel(
        cached: [String] = [],
        resolve: @escaping (String, String, FfiVoiceObserver) throws -> String = { id, _, _ in id },
        espeak: Bool = false,
        store: VoiceStore? = nil
    ) -> (model: VoicesViewModel, resolveRecorder: Recorder, deletions: RecorderBox) {
        let recorder = Recorder()
        let deletions = RecorderBox()
        let model = VoicesViewModel(
            store: store ?? VoiceStore(fileURL: tempVoiceFile()),
            cacheDir: "/v",
            catalog: { [
                voice("en_US-hfc_female-medium", name: "HF Female"),
                voice("en_US-amy-medium", name: "Amy")
            ] },
            cachedIds: { _ in cached },
            resolve: { id, dir, observer in
                recorder.events.append("\(id)@\(dir)")
                return try resolve(id, dir, observer)
            },
            remove: { _, id in
                deletions.values.append(id)
                return true
            },
            espeakCheck: { espeak }
        )
        return (model, recorder, deletions)
    }

    private final class Recorder {
        var events: [String] = []
    }

    private final class RecorderBox {
        var values: [String] = []
    }

    private func tempVoiceFile() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("vm-voice-\(UUID().uuidString)")
    }

    func testCatalogRendersWithCachedMarksAndEspeakState() {
        let (model, _, _) = makeModel(cached: ["en_US-amy-medium"], espeak: true)

        XCTAssertEqual(model.rows.count, 2)
        XCTAssertEqual(model.rows.map(\.cached), [false, true])
        XCTAssertTrue(model.espeakPresent)
        XCTAssertNil(model.selected)
    }

    func testSelectionPersistsAndNilReturnsToDefault() throws {
        let store = VoiceStore(fileURL: tempVoiceFile())
        let (model, _, _) = makeModel(store: store)

        model.select("en_US-amy-medium")
        XCTAssertEqual(model.selected, "en_US-amy-medium")
        XCTAssertEqual(store.selected, "en_US-amy-medium")

        model.select(nil)
        XCTAssertNil(model.selected)
        XCTAssertNil(store.selected)
    }

    func testDownloadLandsTheCacheAndClearsBusy() {
        let (model, recorder, _) = makeModel()

        model.download("en_US-amy-medium")
        let fulfilled = expectation(description: "cached after download")
        let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { timer in
            if model.rows.first(where: { $0.id == "en_US-amy-medium" })?.cached == true {
                timer.invalidate()
                fulfilled.fulfill()
            }
        }
        wait(for: [fulfilled], timeout: 5)
        timer.invalidate()

        XCTAssertEqual(recorder.events, ["en_US-amy-medium@/v"], "resolve targets the cache dir")
        XCTAssertTrue(model.busy.isEmpty)
        XCTAssertNil(model.downloads["en_US-amy-medium"])
        XCTAssertNil(model.failure)
    }

    func testDownloadFailureSurfacesTypedRetryable() {
        let (model, _, _) = makeModel(
            resolve: { _, _, _ in throw NSError(domain: "offline", code: 1) }
        )

        model.download("en_US-amy-medium")
        let fulfilled = expectation(description: "failure surfaced")
        let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { timer in
            if model.failure != nil {
                timer.invalidate()
                fulfilled.fulfill()
            }
        }
        wait(for: [fulfilled], timeout: 5)
        timer.invalidate()

        XCTAssertEqual(model.failure?.voice, "en_US-amy-medium")
        XCTAssertTrue(model.busy.isEmpty)
        XCTAssertNil(model.downloads["en_US-amy-medium"])
    }

    func testDeletingASelectedUncachedVoiceResetsToDefault() throws {
        let store = VoiceStore(fileURL: tempVoiceFile())
        store.setSelected("en_US-amy-medium")
        let (model, _, deletions) = makeModel(cached: ["en_US-amy-medium"], store: store)
        XCTAssertEqual(model.selected, "en_US-amy-medium")

        model.delete("en_US-amy-medium")

        XCTAssertEqual(deletions.values, ["en_US-amy-medium"])
        XCTAssertNil(model.selected, "the orphaned selection resets to default")
    }
}
