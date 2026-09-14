import XCTest
@testable import TaleTrek

/// The task-003 simulator smoke: the real kernel static lib round-trips the
/// committed real-audio fixture — open through the flattened book, decode
/// every segment's bytes to PCM. This is the first proof the whole crossing
/// (UniFFI Swift + static lib + embedded SherpaOnnxC) works on Apple silicon.
final class KernelSmokeTest: XCTestCase {
    private func fixturePath() throws -> String {
        let bundle = Bundle(for: KernelSmokeTest.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: "book-playable", withExtension: "taletrek"),
            "fixture rides the test bundle's resources"
        )
        return url.path
    }

    func testOpensTheFixtureFlattened() throws {
        let path = try fixturePath()
        let book = try openBook(path: path)
        XCTAssertEqual(book.bookId, "bk_sample")
        XCTAssertFalse(book.chapters.isEmpty, "fixture has chapters")
        let paragraphs = book.chapters.flatMap(\.paragraphs)
        XCTAssertFalse(paragraphs.isEmpty, "fixture has paragraphs")
        XCTAssertTrue(book.audioPresent, "fixture declares audio")
        for paragraph in paragraphs {
            XCTAssertFalse(paragraph.segmentKey.isEmpty, "keys are derived")
        }
    }

    func testDecodesEverySegmentToNonEmptyPcm() throws {
        let path = try fixturePath()
        let book = try openBook(path: path)
        let paragraphs = book.chapters.flatMap(\.paragraphs)
        for paragraph in paragraphs {
            let decoded = try decodeSegment(path: path, key: paragraph.segmentKey)
            let audio = try XCTUnwrap(decoded, "segment \(paragraph.segmentKey) exists")
            XCTAssertFalse(audio.samples.isEmpty, "PCM is non-empty")
            XCTAssertGreaterThan(audio.sampleRate, 0)
            XCTAssertGreaterThanOrEqual(audio.channels, 1)
        }
    }
}
